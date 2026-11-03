/** The MK48T08 battery-backed RAM at $fffc0000, as MAME saves it: raw bytes, offset = address - $fffc0000.
 *  See docs/hardware-map.md. Only these fields are editable, and everything else keeps its default. */

export const NVRAM_SIZE = 8192

interface Base {
  id: string
  group: string
  label: string
  offset: number
  hint?: string
}

export type NvramField = Base &
  (
    | { kind: 'byte' | 'u16' | 'flag' }
    | { kind: 'hex'; length: number }
    | { kind: 'nibble'; high: boolean; options?: [number, string][] }
  )

const PARITY: [number, string][] = [[1, 'Odd'], [2, 'None']]

const serial = (prefix: string, group: string, offset: number): NvramField[] => [
  { id: `${prefix}-baud`, group, label: 'Baud', offset, kind: 'u16' },
  { id: `${prefix}-data`, group, label: 'Data bits', offset: offset + 2, kind: 'nibble', high: true },
  { id: `${prefix}-parity`, group, label: 'Parity', offset: offset + 2, kind: 'nibble', high: false, options: PARITY },
  { id: `${prefix}-stop`, group, label: 'Stop code', offset: offset + 3, kind: 'byte', hint: 'The raw value from Setup, not a count of bits' }
]

export const NVRAM_FIELDS: NvramField[] = [
  { id: 'ether', group: 'Network', label: 'Ethernet', offset: 0x779, kind: 'hex', length: 3, hint: 'Follows 08:00:3e. IP addresses are kept on the disk, so set those in Setup\'s Network screen.' },
  ...serial('tablet', 'Tablet port', 0x218),
  { id: 'debug', group: 'Boot', label: 'Debug mode', offset: 0x302, kind: 'byte', hint: 'Also picks the memory size: 0 or 2 selects 4, others 3' }
]

/** What a first boot starts from with no file: the disk entry, serial ports and tablet type
 *  from the driver's ROM region, and the Ethernet bytes boot_stub() fills in. */
export function nvramDefaults(): Uint8Array {
  const data = new Uint8Array(NVRAM_SIZE)
  data[0x0a] = 9
  data[0x0c] = 0x20
  data[0x11] = 1
  data.set([0x4b, 0x00, 0x81, 0x11, 0x25, 0x80, 0x82, 0x03], 0x218)
  data[0x262] = 1
  data[0x411] = 1
  data.set([0x12, 0x34, 0x56], 0x779)
  return data
}

const view = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength)
const nibbleOf = (byte: number, high?: boolean): number => (high ? byte >> 4 : byte & 15)
const hex = (byte: number): string => byte.toString(16).padStart(2, '0')

/** Decimal, or hex with 0x. Null if it isn't a whole number. */
function parseNumber(text: string): number | null {
  const t = text.trim()
  return /^(\d+|0x[0-9a-f]+)$/i.test(t) ? Number(t) : null
}

function parseHex(text: string, length: number): number[] | null {
  const digits = text.trim().replace(/[:\s-]/g, '')
  if (digits.length !== length * 2 || !/^[0-9a-f]+$/i.test(digits)) return null
  return digits.match(/../g)!.map((pair) => parseInt(pair, 16))
}

function maximum(field: NvramField): number {
  switch (field.kind) {
    case 'u16':
      return 0xffff
    case 'nibble':
      return 15
    default:
      return 0xff
  }
}

export function readField(data: Uint8Array, field: NvramField): string {
  const { offset } = field
  switch (field.kind) {
    case 'u16':
      return String(view(data).getUint16(offset))
    case 'hex':
      return [...data.subarray(offset, offset + field.length)].map(hex).join(':')
    case 'nibble':
      return String(nibbleOf(data[offset], field.high))
    default:
      return String(data[offset])
  }
}

/** Why `text` can't go in this field, or null if it can. */
export function fieldError(field: NvramField, text: string): string | null {
  switch (field.kind) {
    case 'hex':
      return parseHex(text, field.length) ? null : `Needs ${field.length} hex bytes`
    default: {
      const value = parseNumber(text)
      return value !== null && value <= maximum(field) ? null : `Needs a number from 0 to ${maximum(field)}`
    }
  }
}

/** `text` must already have passed fieldError. */
export function writeField(data: Uint8Array, field: NvramField, text: string): void {
  const { offset } = field
  const number = parseNumber(text) ?? 0
  switch (field.kind) {
    case 'u16':
      view(data).setUint16(offset, number)
      break
    case 'hex':
      data.set(parseHex(text, field.length)!, offset)
      break
    case 'nibble':
      data[offset] = field.high ? (number << 4) | (data[offset] & 15) : (data[offset] & 0xf0) | number
      break
    default:
      data[offset] = number
  }
}
