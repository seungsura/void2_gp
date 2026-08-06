'use strict';

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const yazl = require('yazl');

const [artifactRoot, outputPath, releaseContentManifestPath, productVersion] = process.argv.slice(2);

if (!artifactRoot || !outputPath || !releaseContentManifestPath || !productVersion) {
	console.error('Usage: node package-portable.js <artifact-root> <output-zip> <release-content-manifest> <product-version>');
	process.exit(2);
}

const normalizedArtifactRoot = path.resolve(artifactRoot);
const normalizedOutputPath = path.resolve(outputPath);
const normalizedManifestPath = path.resolve(releaseContentManifestPath);
const contentRoot = path.dirname(normalizedManifestPath);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
// ZIP DOS timestamps support 1980-2107. Use a fixed, non-boundary local time so
// supplemental buffers do not inherit yazl's default current timestamp.
const supplementalZipMtime = new Date(2000, 0, 1, 0, 0, 0, 0);
const supplementalZipMode = 0o100644;
const windowsReservedDeviceName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const windowsInvalidSegmentCharacters = /[\u0000-\u001f<>:"\\|?*]/u;

const readStrictUtf8 = (filePath) => {
	const bytes = fs.readFileSync(filePath);
	if (bytes.length === 0) {
		throw new Error(`Release content is empty: ${filePath}`);
	}
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw new Error(`Release content must be UTF-8 without BOM: ${filePath}`);
	}
	try {
		return { bytes, text: strictUtf8.decode(bytes) };
	} catch {
		throw new Error(`Release content is not strict UTF-8: ${filePath}`);
	}
};

const canonicalRelativePath = (value, purpose) => {
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes(':') || value.endsWith('/')) {
		throw new Error(`Release content ${purpose} path is not canonical: ${String(value)}`);
	}
	const segments = value.split('/');
	if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(`Release content ${purpose} path is unsafe: ${value}`);
	}
	for (const segment of segments) {
		const deviceBaseName = segment.split('.', 1)[0];
		if (segment.endsWith('.') || segment.endsWith(' ') || windowsInvalidSegmentCharacters.test(segment) || windowsReservedDeviceName.test(deviceBaseName)) {
			throw new Error(`Release content ${purpose} path contains a Windows-unsafe segment: ${value}`);
		}
	}
	return value;
};

const assertProperties = (value, allowed, required, purpose) => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Release content ${purpose} must be an object.`);
	}
	const names = Object.keys(value);
	const unknown = names.filter(name => !allowed.includes(name));
	const missing = required.filter(name => !Object.prototype.hasOwnProperty.call(value, name));
	if (unknown.length || missing.length) {
		throw new Error(`Release content ${purpose} has unknown or missing properties. Unknown=[${unknown.join(', ')}] Missing=[${missing.join(', ')}]`);
	}
};

const resolveRegularSource = (relativePath) => {
	const root = fs.realpathSync.native(contentRoot);
	let current = root;
	for (const segment of relativePath.split('/')) {
		current = path.join(current, segment);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) {
			throw new Error(`Release content source path contains a symbolic link: ${relativePath}`);
		}
	}
	const resolved = path.resolve(current);
	if (!resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`) || !fs.statSync(resolved).isFile()) {
		throw new Error(`Release content source is not a contained regular file: ${relativePath}`);
	}
	return resolved;
};

const placeholderMatches = text => text.match(/\{\{[^{}\r\n]+\}\}/g) || [];

const loadPortableEntries = () => {
	const manifestData = readStrictUtf8(normalizedManifestPath);
	let manifest;
	try {
		manifest = JSON.parse(manifestData.text);
	} catch {
		throw new Error(`Release content manifest is not strict JSON: ${normalizedManifestPath}`);
	}
	assertProperties(manifest, ['schemaVersion', 'entries'], ['schemaVersion', 'entries'], 'manifest root');
	if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
		throw new Error('Release content manifest has an unsupported schema or no entries.');
	}

	const sources = new Set();
	const outerPaths = new Set();
	const portablePaths = new Set();
	const portableEntries = [];
	let outerMetadataCount = 0;
	let productVersionCount = 0;

	for (const entry of manifest.entries) {
		assertProperties(entry, ['source', 'outerPath', 'portablePath', 'materialization'], ['source', 'materialization'], 'manifest entry');
		const source = canonicalRelativePath(entry.source, 'source');
		const outerPath = Object.prototype.hasOwnProperty.call(entry, 'outerPath') ? canonicalRelativePath(entry.outerPath, 'outer') : null;
		const portablePath = Object.prototype.hasOwnProperty.call(entry, 'portablePath') ? canonicalRelativePath(entry.portablePath, 'portable') : null;
		if (!outerPath && !portablePath) {
			throw new Error(`Release content entry has no destination: ${source}`);
		}
		if (!['copy', 'outer-metadata', 'product-version'].includes(entry.materialization)) {
			throw new Error(`Unsupported release content materialization: ${entry.materialization}`);
		}
		const sourceKey = source.toLowerCase();
		if (sources.has(sourceKey)) {
			throw new Error(`Duplicate release content source: ${source}`);
		}
		sources.add(sourceKey);
		if (outerPath) {
			const outerKey = outerPath.toLowerCase();
			if (outerPaths.has(outerKey)) {
				throw new Error(`Duplicate or case-colliding outer path: ${outerPath}`);
			}
			outerPaths.add(outerKey);
		}
		if (portablePath) {
			if (!portablePath.startsWith('docs/')) {
				throw new Error(`Portable release content must use canonical docs/ paths: ${portablePath}`);
			}
			const portableKey = portablePath.toLowerCase();
			if (portablePaths.has(portableKey)) {
				throw new Error(`Duplicate or case-colliding portable path: ${portablePath}`);
			}
			portablePaths.add(portableKey);
		}

		if (entry.materialization === 'outer-metadata') {
			outerMetadataCount++;
			if (outerPath !== 'README.md' || portablePath) {
				throw new Error('outer-metadata is restricted to the outer-only README.md entry.');
			}
		}
		if (entry.materialization === 'product-version') {
			productVersionCount++;
			if (outerPath || !portablePath) {
				throw new Error('product-version is restricted to portable-only content.');
			}
		}

		const sourcePath = resolveRegularSource(source);
		const sourceData = readStrictUtf8(sourcePath);
		if (sourceData.text.includes('gpt-5.6-luna-2026-07-09') || /(?<![a-z0-9])gpt-[a-z0-9._-]*\d{4}-\d{2}-\d{2}(?![a-z0-9])/i.test(sourceData.text)) {
			throw new Error(`Release content contains a dated internal model route: ${source}`);
		}
		if (portablePath && /([A-Z]:\\|\bapi[ _-]?key\b|\bcustom headers?\b|\b(?:task|thread)[ _-]?ids?\b|\bcorporate host\b|사내|\bspec[\\/])/i.test(sourceData.text)) {
			throw new Error(`Portable release content contains forbidden internal or sensitive text: ${source}`);
		}
		const placeholders = placeholderMatches(sourceData.text);
		if (entry.materialization === 'copy' && placeholders.length) {
			throw new Error(`Copy release content has an unresolved placeholder: ${source}`);
		}
		if (entry.materialization === 'outer-metadata') {
			const approved = ['{{PORTABLE_SIZE}}', '{{PORTABLE_SHA256}}', '{{PORTABLE_ENTRIES}}', '{{SOURCE_HEAD}}', '{{BUILD_DATE_KST}}'];
			if (placeholders.length !== approved.length || approved.some(token => placeholders.filter(found => found === token).length !== 1)) {
				throw new Error('Outer README placeholders must be exactly the approved five once each.');
			}
		}
		if (entry.materialization === 'product-version' && (placeholders.length !== 1 || placeholders[0] !== '{{PRODUCT_VERSION}}')) {
			throw new Error(`product-version content must contain exactly one {{PRODUCT_VERSION}} placeholder: ${source}`);
		}

		if (portablePath) {
			let bytes;
			if (entry.materialization === 'copy') {
				bytes = sourceData.bytes;
			} else if (entry.materialization === 'product-version') {
				const text = sourceData.text.replace('{{PRODUCT_VERSION}}', productVersion);
				if (placeholderMatches(text).length) {
					throw new Error(`Portable release content has an unresolved placeholder: ${source}`);
				}
				bytes = Buffer.from(text, 'utf8');
			} else {
				throw new Error(`Portable destination cannot use materialization ${entry.materialization}: ${source}`);
			}
			if (bytes.length === 0) {
				throw new Error(`Materialized portable release content is empty: ${source}`);
			}
			portableEntries.push({ relativePath: portablePath, bytes });
		}
	}

	if (outerMetadataCount !== 1 || productVersionCount !== 1) {
		throw new Error(`Release content manifest requires exactly one outer-metadata and one product-version entry; got ${outerMetadataCount}/${productVersionCount}.`);
	}
	return portableEntries;
};

if (!fs.existsSync(normalizedArtifactRoot)) {
	console.error(`Artifact root does not exist: ${normalizedArtifactRoot}`);
	process.exit(2);
}

const excluded = (relativePath) => {
	const normalized = relativePath.replace(/\\/g, '/');
	return normalized === 'data/argv.json' || normalized.startsWith('data/user-data/');
};

const files = [];
const seenArchivePaths = new Set();
const addArchivePath = (relativePath) => {
	const key = relativePath.toLowerCase();
	if (seenArchivePaths.has(key)) {
		throw new Error(`Portable ZIP path collision: ${relativePath}`);
	}
	seenArchivePaths.add(key);
};

const walk = (directory, relativeDirectory = '') => {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const absolutePath = path.join(directory, entry.name);
		const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
		if (entry.isDirectory()) {
			walk(absolutePath, relativePath);
		} else if (entry.isFile() && !excluded(relativePath)) {
			const archivePath = relativePath.replace(/\\/g, '/');
			if (archivePath.toLowerCase() === 'docs' || archivePath.toLowerCase().startsWith('docs/')) {
				throw new Error(`ArtifactRoot contains a docs path that collides with manifest supplemental content: ${archivePath}`);
			}
			addArchivePath(archivePath);
			files.push({ absolutePath, relativePath: archivePath });
		}
	}
};

try {
	walk(normalizedArtifactRoot);
	for (const supplemental of loadPortableEntries()) {
		addArchivePath(supplemental.relativePath);
		files.push(supplemental);
	}
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exit(2);
}

files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);

fs.mkdirSync(path.dirname(normalizedOutputPath), { recursive: true });
if (fs.existsSync(normalizedOutputPath)) {
	fs.unlinkSync(normalizedOutputPath);
}

const zipFile = new yazl.ZipFile();
const output = fs.createWriteStream(normalizedOutputPath);
let settled = false;

const fail = (error) => {
	if (settled) {
		return;
	}
	settled = true;
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
};

output.on('error', fail);
output.on('close', () => {
	if (settled) {
		return;
	}
	settled = true;
	const bytes = fs.statSync(normalizedOutputPath).size;
	console.log(JSON.stringify({ output: normalizedOutputPath, entries: files.length, bytes }));
});

for (const file of files) {
	if (file.absolutePath) {
		zipFile.addFile(file.absolutePath, file.relativePath);
	} else {
		zipFile.addBuffer(file.bytes, file.relativePath, { mtime: supplementalZipMtime, mode: supplementalZipMode });
	}
}

zipFile.outputStream.on('error', fail);
zipFile.outputStream.pipe(output);
zipFile.end();
