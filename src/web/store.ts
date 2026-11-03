/** What's kept in this browser between visits. Keys are in FILES. */

const DATABASE = 'maxine-studio-emulator'
const STORE = 'files'

export const FILES = { nvram: 'nvram', disk: 'disk', image: 'disk-image' }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact<T>(mode: IDBTransactionMode, run: (files: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open()
  return new Promise((resolve, reject) => {
    const request = run(database.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).finally(() => database.close()) as Promise<T>
}

export const readFile = <T = Uint8Array>(key: string): Promise<T | undefined> => transact<T | undefined>('readonly', (files) => files.get(key))
export const writeFile = (key: string, value: Uint8Array | string): Promise<unknown> => transact('readwrite', (files) => files.put(value, key))
export const removeFile = (key: string): Promise<undefined> => transact('readwrite', (files) => files.delete(key))
export const hasSavedDisk = async (): Promise<boolean> => (await transact('readonly', (files) => files.getKey(FILES.disk))) !== undefined
