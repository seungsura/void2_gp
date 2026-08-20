import assert from 'assert';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IEncryptionService, KnownStorageProvider } from '../../../../../platform/encryption/common/encryptionService.js';
import { IMetricsService } from '../../common/metricsService.js';
import { VoidSettingsService } from '../../common/voidSettingsService.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { VOID_SETTINGS_STORAGE_KEY } from '../../common/storageKeys.js';

class TestEncryptionService implements IEncryptionService {
	_serviceBrand: undefined;
	setUsePlainTextEncryption(): Promise<void> { return Promise.resolve(); }
	getKeyStorageProvider(): Promise<KnownStorageProvider> { return Promise.resolve(KnownStorageProvider.basicText); }
	encrypt(value: string): Promise<string> { return Promise.resolve(`encrypted+${value}`); }
	decrypt(value: string): Promise<string> { return Promise.resolve(value.slice('encrypted+'.length)); }
	isEncryptionAvailable(): Promise<boolean> { return Promise.resolve(true); }
}

class TestMetricsService implements IMetricsService {
	_serviceBrand: undefined;
	capture(): void { }
	setOptOut(): void { }
	getDebuggingProperties(): Promise<object> { return Promise.resolve({}); }
}

class DeferredEncryptionService extends TestEncryptionService {
	readonly calls: Array<{ value: string; resolve: (value: string) => void; reject: (error: Error) => void }> = [];
	override encrypt(value: string): Promise<string> {
		return new Promise<string>((resolve, reject) => this.calls.push({ value, resolve, reject }));
	}
}

class SwitchableEncryptionService extends TestEncryptionService {
	deferred: DeferredEncryptionService | undefined;
	override encrypt(value: string): Promise<string> { return this.deferred ? this.deferred.encrypt(value) : super.encrypt(value); }
}

const waitForCallCount = async (encryption: DeferredEncryptionService, expected: number): Promise<void> => {
	for (let turn = 0; turn < 20; turn++) {
		if (encryption.calls.length === expected) return;
		await Promise.resolve();
	}
	assert.fail(`Expected ${expected} encryption calls, received ${encryption.calls.length}`);
};

suite('Void settings persistence', () => {
	test('serializes concurrent state writes before a later encryption can start', async () => {
		const storage = new InMemoryStorageService();
		const encryption = new DeferredEncryptionService();
		const service = new VoidSettingsService(storage, encryption, new TestMetricsService());
		await service.waitForInitState;
		const first = service.setSettingOfProvider('openAI', 'apiKey', 'first-key');
		await waitForCallCount(encryption, 1);
		const second = service.setSettingOfProvider('openAI', 'apiKey', 'second-key');
		await Promise.resolve();
		assert.strictEqual(encryption.calls.length, 1, 'the second write must not encrypt before the first settles');
		encryption.calls[0].resolve(`encrypted+${encryption.calls[0].value}`);
		await waitForCallCount(encryption, 2);
		encryption.calls[1].resolve(`encrypted+${encryption.calls[1].value}`);
		await Promise.all([first, second]);
		const stored = storage.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);
		assert.ok(stored);
		assert.strictEqual(JSON.parse(stored.slice('encrypted+'.length)).settingsOfProvider.openAI.apiKey, 'second-key');
		service.dispose(); storage.dispose();
	});

	test('awaits Chat-derived Apply and SCM synchronization before completion', async () => {
		const storage = new InMemoryStorageService();
		const encryption = new SwitchableEncryptionService();
		const service = new VoidSettingsService(storage, encryption, new TestMetricsService());
		await service.waitForInitState;
		await service.setSettingOfProvider('openAI', 'apiKey', 'smoke-test-key');
		const deferred = new DeferredEncryptionService();
		encryption.deferred = deferred;
		const selection = { providerName: 'openAI' as const, modelName: 'gpt-4.1' };
		const completion = service.setModelSelectionOfFeature('Chat', selection);
		let settled = false;
		void completion.then(() => { settled = true; });
		await waitForCallCount(deferred, 1); deferred.calls[0].resolve(`encrypted+${deferred.calls[0].value}`);
		await waitForCallCount(deferred, 2); deferred.calls[1].resolve(`encrypted+${deferred.calls[1].value}`);
		await Promise.resolve();
		assert.strictEqual(settled, false, 'Chat completion must wait for SCM synchronization');
		await waitForCallCount(deferred, 3);
		assert.strictEqual(settled, false, 'Chat completion must not settle before the final derived write resolves');
		deferred.calls[2].resolve(`encrypted+${deferred.calls[2].value}`);
		await completion;
		assert.deepStrictEqual([service.state.modelSelectionOfFeature.Chat, service.state.modelSelectionOfFeature.Apply, service.state.modelSelectionOfFeature.SCM], [selection, selection, selection]);
		const stored = storage.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);
		assert.ok(stored);
		const persisted = JSON.parse(stored.slice('encrypted+'.length));
		assert.deepStrictEqual([persisted.modelSelectionOfFeature.Chat, persisted.modelSelectionOfFeature.Apply, persisted.modelSelectionOfFeature.SCM], [selection, selection, selection]);
		service.dispose(); storage.dispose();
	});

	test('recovers the queue after an encryption rejection', async () => {
		const storage = new InMemoryStorageService(); const encryption = new DeferredEncryptionService(); const service = new VoidSettingsService(storage, encryption, new TestMetricsService());
		await service.waitForInitState;
		const failed = service.setSettingOfProvider('openAI', 'apiKey', 'first-key'); await waitForCallCount(encryption, 1); encryption.calls[0].reject(new Error('first write failed'));
		await assert.rejects(failed, /first write failed/);
		const next = service.setSettingOfProvider('openAI', 'apiKey', 'second-key'); await waitForCallCount(encryption, 2); encryption.calls[1].resolve(`encrypted+${encryption.calls[1].value}`); await next;
		const stored = storage.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);
		assert.ok(stored);
		assert.strictEqual(JSON.parse(stored.slice('encrypted+'.length)).settingsOfProvider.openAI.apiKey, 'second-key');
		service.dispose(); storage.dispose();
	});
});
