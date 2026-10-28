// GramJS reads globalThis.localStorage while it loads. Node's experimental
// getter warns unless a storage file is configured. An inert store keeps that
// read quiet and does not persist anything to disk.
const memoryStorage = {
  getItem: (): null => null,
  setItem: (): void => undefined,
  removeItem: (): void => undefined,
  clear: (): void => undefined,
  key: (): null => null,
  get length(): number {
    return 0;
  },
};

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
if (!descriptor || descriptor.configurable) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: memoryStorage,
  });
}
