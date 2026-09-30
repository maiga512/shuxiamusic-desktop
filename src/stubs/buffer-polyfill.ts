// Minimal Buffer polyfill for nsfwjs browser compatibility.
// The real `buffer` npm package is ~40KB; for nsfwjs's limited use of Buffer
// (mainly base64/hex encoding), a small shim suffices.

function utf8ToBytes(str: string): Uint8Array {
  const encoder = new TextEncoder()
  return encoder.encode(str)
}

function resolveBlobUrl(url: string): string {
  return url
}

export class BufferShim {
  static from(data: string | Uint8Array | ArrayBuffer | ArrayLike<number> | BufferShim, encoding?: string): BufferShim {
    if (data instanceof BufferShim) {
      return new BufferShim(data.toUint8Array())
    }
    if (typeof data === 'string') {
      if (encoding === 'base64') {
        const binary = atob(data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return new BufferShim(bytes)
      }
      if (encoding === 'hex') {
        const clean = data.trim().replace(/^0x/i, '')
        const bytes = new Uint8Array(Math.ceil(clean.length / 2))
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2).padEnd(2, '0'), 16) || 0
        }
        return new BufferShim(bytes)
      }
      return new BufferShim(utf8ToBytes(data))
    }
    if (data instanceof ArrayBuffer) {
      return new BufferShim(new Uint8Array(data))
    }
    if (data instanceof Uint8Array) {
      return new BufferShim(data)
    }
    return new BufferShim(new Uint8Array(Array.from(data)))
  }

  static alloc(size: number, fill?: number): BufferShim {
    const buf = new Uint8Array(size)
    if (fill !== undefined) buf.fill(fill)
    return new BufferShim(buf)
  }

  static concat(list: BufferShim[]): BufferShim {
    const total = list.reduce((acc, b) => acc + b._data.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const b of list) {
      result.set(b._data, offset)
      offset += b._data.length
    }
    return new BufferShim(result)
  }

  static isBuffer(input: unknown): input is BufferShim {
    return input instanceof BufferShim
  }

  private _data: Uint8Array

  constructor(data: Uint8Array) {
    this._data = data
  }

  get length(): number { return this._data.length }

  valueOf(): Uint8Array {
    return this.toUint8Array()
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this._data)
  }

  [Symbol.iterator](): IterableIterator<number> {
    return this._data[Symbol.iterator]()
  }

  toString(encoding?: string): string {
    if (encoding === 'base64') {
      let binary = ''
      for (let i = 0; i < this._data.length; i++) {
        binary += String.fromCharCode(this._data[i])
      }
      return btoa(binary)
    }
    if (encoding === 'hex') {
      return Array.from(this._data).map(b => b.toString(16).padStart(2, '0')).join('')
    }
    // default utf-8
    return new TextDecoder().decode(this._data)
  }

  slice(start?: number, end?: number): BufferShim {
    return new BufferShim(this._data.slice(start, end))
  }

  writeUInt8(value: number, offset: number): void {
    this._data[offset] = value
  }

  readUInt8(offset: number): number {
    return this._data[offset]
  }

  toJSON(): { type: string; data: number[] } {
    return { type: 'Buffer', data: Array.from(this._data) }
  }
}

const Buffer = BufferShim
export { Buffer }
export default BufferShim