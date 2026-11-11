// Package xxhash32 is XXH32, the 32-bit xxHash, as xxhash-wasm's h32 computes
// it. diff-tools' hashline anchors hash each canonical line with it.
//
// h32(input, seed) in xxhash-wasm encodes the JavaScript string as UTF-8
// (TextEncoder) and hashes the bytes. A Go string is already UTF-8, so
// Sum(s, seed) hashes the same bytes. A lone surrogate becomes U+FFFD in both.
package xxhash32

import "math/bits"

const (
	prime1 uint32 = 2654435761
	prime2 uint32 = 2246822519
	prime3 uint32 = 3266489917
	prime4 uint32 = 668265263
	prime5 uint32 = 374761393
)

func round(acc, input uint32) uint32 {
	acc += input * prime2
	acc = bits.RotateLeft32(acc, 13)
	return acc * prime1
}

func le32(b []byte) uint32 {
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
}

// Sum is xxhash-wasm's h32(input, seed): XXH32 of the UTF-8 bytes of s.
func Sum(s string, seed uint32) uint32 { return SumBytes([]byte(s), seed) }

// SumBytes is XXH32 of data with seed.
func SumBytes(data []byte, seed uint32) uint32 {
	n := len(data)
	var h uint32
	p := 0
	if n >= 16 {
		v1 := seed + prime1 + prime2
		v2 := seed + prime2
		v3 := seed
		v4 := seed - prime1
		for ; p+16 <= n; p += 16 {
			v1 = round(v1, le32(data[p:]))
			v2 = round(v2, le32(data[p+4:]))
			v3 = round(v3, le32(data[p+8:]))
			v4 = round(v4, le32(data[p+12:]))
		}
		h = bits.RotateLeft32(v1, 1) + bits.RotateLeft32(v2, 7) + bits.RotateLeft32(v3, 12) + bits.RotateLeft32(v4, 18)
	} else {
		h = seed + prime5
	}
	h += uint32(n)
	for ; p+4 <= n; p += 4 {
		h += le32(data[p:]) * prime3
		h = bits.RotateLeft32(h, 17) * prime4
	}
	for ; p < n; p++ {
		h += uint32(data[p]) * prime5
		h = bits.RotateLeft32(h, 11) * prime1
	}
	h ^= h >> 15
	h *= prime2
	h ^= h >> 13
	h *= prime3
	h ^= h >> 16
	return h
}
