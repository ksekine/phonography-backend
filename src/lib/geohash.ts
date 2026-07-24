const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * 緯度経度を geohash にエンコードする。
 * precision 7 でセル幅 ≈ 153m × 153m(ビューポート検索・クラスタリング補助用)。
 */
export function encodeGeohash(
  latitude: number,
  longitude: number,
  precision = 7
): string {
  let minLat = -90;
  let maxLat = 90;
  let minLng = -180;
  let maxLng = 180;
  let hash = "";
  let bits = 0;
  let bit = 0;
  let evenBit = true;

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (minLng + maxLng) / 2;
      if (longitude >= mid) {
        bits = (bits << 1) | 1;
        minLng = mid;
      } else {
        bits = bits << 1;
        maxLng = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (latitude >= mid) {
        bits = (bits << 1) | 1;
        minLat = mid;
      } else {
        bits = bits << 1;
        maxLat = mid;
      }
    }
    evenBit = !evenBit;
    bit++;
    if (bit === 5) {
      hash += BASE32[bits];
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}
