type City = readonly [country: string, lat: number, lon: number];

// City centres rounded to a tenth of a degree. The field never asks for the device's position.
const CITIES: Readonly<Record<string, City>> = {
  "Europe/Zurich": ["CH", 47.4, 8.5],
  "Europe/Berlin": ["DE", 52.5, 13.4],
  "Europe/Vienna": ["AT", 48.2, 16.4],
  "Europe/Paris": ["FR", 48.9, 2.3],
  "Europe/Rome": ["IT", 41.9, 12.5],
  "Europe/London": ["GB", 51.5, -0.1],
  "Europe/Dublin": ["IE", 53.3, -6.3],
  "Europe/Amsterdam": ["NL", 52.4, 4.9],
  "Europe/Brussels": ["BE", 50.8, 4.4],
  "Europe/Luxembourg": ["LU", 49.6, 6.1],
  "Europe/Madrid": ["ES", 40.4, -3.7],
  "Europe/Lisbon": ["PT", 38.7, -9.1],
  "Europe/Copenhagen": ["DK", 55.7, 12.6],
  "Europe/Stockholm": ["SE", 59.3, 18.1],
  "Europe/Oslo": ["NO", 59.9, 10.8],
  "Europe/Helsinki": ["FI", 60.2, 24.9],
  "Europe/Warsaw": ["PL", 52.2, 21],
  "Europe/Prague": ["CZ", 50.1, 14.4],
  "America/New_York": ["US", 40.7, -74],
  "America/Chicago": ["US", 41.9, -87.6],
  "America/Denver": ["US", 39.7, -105],
  "America/Los_Angeles": ["US", 34.1, -118.2],
  "America/Toronto": ["CA", 43.7, -79.4],
  "America/Vancouver": ["CA", 49.3, -123.1],
  "America/Mexico_City": ["MX", 19.4, -99.1],
  "America/Sao_Paulo": ["BR", -23.6, -46.6],
  "Asia/Kolkata": ["IN", 22.6, 88.4],
  "Asia/Singapore": ["SG", 1.3, 103.8],
  "Asia/Tokyo": ["JP", 35.7, 139.7],
  "Australia/Sydney": ["AU", -33.9, 151.2],
  "Pacific/Auckland": ["NZ", -36.8, 174.8],
};

export function placeRegion(zone: string | null | undefined, deviceZone: string) {
  const city = CITIES[zone ?? ""] ?? CITIES[deviceZone];
  if (city) {
    const [home, lat, lon] = city;
    return { home, near: { lat, lon } };
  }
  return {};
}

export function placeSecondLine(
  locality: string,
  country: string | null,
  home: string | undefined,
  locale: string,
) {
  if (!country || country === home || !/^[A-Z]{2}$/.test(country)) return locality;
  const name = new Intl.DisplayNames(locale, { type: "region" }).of(country);
  return [locality, name].filter(Boolean).join(", ");
}
