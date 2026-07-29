/**
 * Anti-SSRF URL validation.
 *
 * Ported directly from `browser-search/scripts/cloak/lib/url-validation.mjs`
 * (MIT) by PartMent. Blocks loopback, link-local, RFC1918 private ranges, cloud
 * metadata endpoints, and reserved TEST-NETs — plus an async DNS resolution step
 * that rejects hostnames that resolve to private IPs (DNS-rebinding defense).
 *
 * `localhost` access is intentionally blocked for *user-supplied* URLs only;
 * the module's own backend calls (SearXNG :8080, Camofox :9377) do not go
 * through this guard.
 */

import { lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";

const lookupAsync = promisify(dnsLookup);

const BLOCKED_RANGES = [
	{ cidr: "127.0.0.0", prefixLen: 8 },
	{ cidr: "169.254.0.0", prefixLen: 16 },
	{ cidr: "10.0.0.0", prefixLen: 8 },
	{ cidr: "172.16.0.0", prefixLen: 12 },
	{ cidr: "192.168.0.0", prefixLen: 16 },
	{ cidr: "0.0.0.0", prefixLen: 8 },
	{ cidr: "100.64.0.0", prefixLen: 10 }, // CGNAT
	{ cidr: "192.0.0.0", prefixLen: 24 }, // IETF Protocol Assignments
	{ cidr: "192.0.2.0", prefixLen: 24 }, // TEST-NET-1
	{ cidr: "198.51.100.0", prefixLen: 24 }, // TEST-NET-2
	{ cidr: "203.0.113.0", prefixLen: 24 }, // TEST-NET-3
	{ cidr: "224.0.0.0", prefixLen: 4 }, // Multicast
	{ cidr: "240.0.0.0", prefixLen: 4 }, // Reserved
] as const;

const BLOCKED_HOSTNAMES = new Set([
	"metadata.google.internal",
	"metadata.google.internal.",
	"instance-data.pai.googleapis.com",
	"instance-data.pai.googleapis.com.",
]);

const BLOCKED_IPV6_PATTERNS = [
	/^::$/, // unspecified
	/^::1$/, // loopback
	/^fe80:/i, // link-local
	/^fc/i,
	/^fd/i, // unique local
	/^ff/i, // multicast
];

export type UrlValidation = { valid: true } | { valid: false; reason: string };

function ipToNumber(ip: string): number {
	const parts = ip.split(".").map(Number);
	// parts.length === 4 guaranteed by caller
	return (
		((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
	);
}

function isInBlockedRange(ip: string): boolean {
	const ipNum = ipToNumber(ip);
	for (const { cidr, prefixLen } of BLOCKED_RANGES) {
		const networkNum = ipToNumber(cidr);
		const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
		if ((ipNum & mask) === (networkNum & mask)) return true;
	}
	return false;
}

function isBlockedIPv6(ip: string): boolean {
	if (BLOCKED_IPV6_PATTERNS.some((re) => re.test(ip))) return true;
	const mapped = ip.match(/^::ffff:(.+)$/i)?.[1];
	if (!mapped) return false;
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mapped)) {
		return isInBlockedRange(mapped);
	}
	const [highText, lowText, ...rest] = mapped.split(":");
	if (rest.length > 0 || !highText || !lowText) return false;
	const high = Number.parseInt(highText, 16);
	const low = Number.parseInt(lowText, 16);
	if (!Number.isInteger(high) || !Number.isInteger(low)) return false;
	const ipv4 = [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
	return isInBlockedRange(ipv4);
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Synchronous structural validation (no DNS). */
export function validateUrl(url: string): UrlValidation {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { valid: false, reason: "Invalid URL format" };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { valid: false, reason: `Blocked scheme: ${parsed.protocol}` };
	}

	const hostname = parsed.hostname.toLowerCase();
	if (!hostname) return { valid: false, reason: "Missing hostname" };
	if (BLOCKED_HOSTNAMES.has(hostname)) {
		return {
			valid: false,
			reason: "Blocked hostname: cloud metadata endpoint",
		};
	}
	if (hostname === "localhost" || hostname === "localhost.") {
		return { valid: false, reason: "Blocked hostname: localhost" };
	}

	if (IPV4_RE.test(hostname)) {
		if (isInBlockedRange(hostname)) {
			return { valid: false, reason: `Blocked IP: ${hostname}` };
		}
		return { valid: true };
	}

	if (/^\[.*\]$/.test(hostname) || hostname.includes(":")) {
		const ipv6 = hostname.replace(/^\[|\]$/g, "");
		if (isBlockedIPv6(ipv6)) {
			return { valid: false, reason: `Blocked IPv6: ${ipv6}` };
		}
		return { valid: true };
	}

	if (
		hostname.endsWith(".internal") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".lan")
	) {
		return { valid: false, reason: `Blocked TLD: ${hostname}` };
	}

	return { valid: true };
}

/** Async DNS-rebinding check on top of {@link validateUrl}. */
export async function validateUrlWithDns(url: string): Promise<UrlValidation> {
	const syncResult = validateUrl(url);
	if (!syncResult.valid) return syncResult;

	// validateUrl already parsed this once; re-parse defensively so malformed
	// input can never throw out of this async path.
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { valid: false, reason: "Invalid URL format" };
	}
	const hostname = parsed.hostname.toLowerCase();
	if (IPV4_RE.test(hostname)) return syncResult; // already validated

	let resolved: Array<{ address: string; family: number }>;
	try {
		resolved = await lookupAsync(hostname, { all: true });
	} catch (err) {
		return {
			valid: false,
			reason: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (resolved.length === 0) {
		return { valid: false, reason: "DNS lookup returned no addresses" };
	}
	for (const { address, family } of resolved) {
		if (family === 6) {
			if (isBlockedIPv6(address)) {
				return {
					valid: false,
					reason: `DNS resolved to blocked IPv6: ${address}`,
				};
			}
		} else if (isInBlockedRange(address)) {
			return {
				valid: false,
				reason: `DNS resolved to blocked IP: ${address}`,
			};
		}
	}

	return { valid: true };
}
