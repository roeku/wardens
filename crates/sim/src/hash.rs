//! FNV-1a (64-bit), the state hash that replays and the native-vs-WASM test compare.

const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const PRIME: u64 = 0x0000_0100_0000_01b3;

pub struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Fnv {
        Fnv(OFFSET)
    }
}

impl Fnv {
    pub fn bytes(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 ^= b as u64;
            self.0 = self.0.wrapping_mul(PRIME);
        }
    }

    pub fn u32(&mut self, v: u32) {
        self.bytes(&v.to_le_bytes());
    }

    pub fn f64(&mut self, v: f64) {
        self.bytes(&v.to_bits().to_le_bytes());
    }

    pub fn f32(&mut self, v: f32) {
        self.bytes(&v.to_bits().to_le_bytes());
    }

    pub fn finish(&self) -> u64 {
        self.0
    }
}
