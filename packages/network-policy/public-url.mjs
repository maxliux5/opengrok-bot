import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
export const blockedIpv4Cidrs = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
];
for (const cidr of blockedIpv4Cidrs) {
  const [network, prefix] = cidr.split("/");
  blocked.addSubnet(network, Number(prefix), "ipv4");
}
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10]]) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export async function resolvePublicUrl(value, protocols = ["http:", "https:"], resolve = lookup) {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username || url.password) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const family = isIP(hostname);
    if ((!family && !hostname.includes(".")) || hostname.endsWith(".local") ||
      hostname.endsWith(".internal")) return null;
    const addresses = family ? [{ address: hostname, family }] :
      await resolve(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry =>
      blocked.check(entry.address, `ipv${entry.family}`))) return null;
    return { url, addresses };
  } catch {
    return null;
  }
}

export async function publicUrl(value, protocols, resolve) {
  return Boolean(await resolvePublicUrl(value, protocols, resolve));
}
