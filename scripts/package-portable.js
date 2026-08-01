'use strict';

const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

const [artifactRoot, outputPath] = process.argv.slice(2);

if (!artifactRoot || !outputPath) {
	console.error('Usage: node package-portable.js <artifact-root> <output-zip>');
	process.exit(2);
}

const normalizedArtifactRoot = path.resolve(artifactRoot);
const normalizedOutputPath = path.resolve(outputPath);

if (!fs.existsSync(normalizedArtifactRoot)) {
	console.error(`Artifact root does not exist: ${normalizedArtifactRoot}`);
	process.exit(2);
}

const excluded = (relativePath) => {
	const normalized = relativePath.replace(/\\/g, '/');
	return normalized === 'data/argv.json' || normalized.startsWith('data/user-data/');
};

const files = [];
const walk = (directory, relativeDirectory = '') => {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const absolutePath = path.join(directory, entry.name);
		const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
		if (entry.isDirectory()) {
			walk(absolutePath, relativePath);
		} else if (entry.isFile() && !excluded(relativePath)) {
			files.push({ absolutePath, relativePath: relativePath.replace(/\\/g, '/') });
		}
	}
};

walk(normalizedArtifactRoot);
files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

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
	zipFile.addFile(file.absolutePath, file.relativePath);
}

zipFile.outputStream.on('error', fail);
zipFile.outputStream.pipe(output);
zipFile.end();
