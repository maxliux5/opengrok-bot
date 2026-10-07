import { execFileSync } from "node:child_process";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { createEgressGateway } from "../apps/egress-gateway/server.mjs";

const networkName = process.env.OPENGROK_EGRESS_NETWORK || "desktop_default";
if (!/^[A-Za-z0-9_-]+$/.test(networkName)) throw new Error("Invalid desktop egress network name");
const network = JSON.parse(execFileSync("sudo", ["-n", "docker", "network", "inspect", networkName],
  { encoding: "utf8" }))[0];
const host = network?.IPAM?.Config?.[0]?.Gateway;
const subnet = network?.IPAM?.Config?.[0]?.Subnet;
const port = Number(process.env.OPENGROK_EGRESS_PORT || 3888);
const [subnetAddress, prefixText] = subnet?.split("/") || [];
const prefix = Number(prefixText);
if (isIP(host) !== 4 || isIP(subnetAddress) !== 4 || !Number.isInteger(prefix) ||
  prefix < 0 || prefix > 32 || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Desktop gateway or egress port is unavailable");
}
const allowedClients = new BlockList();
allowedClients.addSubnet(subnetAddress, prefix, "ipv4");
for (const entry of Object.values(networkInterfaces()).flat()) {
  if (entry?.family === "IPv4") allowedClients.addAddress(entry.address, "ipv4");
}
const server = createEgressGateway({ upstreamProxy: process.env.OPENGROK_BROWSER_PROXY });
server.on("connection", socket => {
  if (!socket.remoteAddress || !allowedClients.check(socket.remoteAddress, "ipv4")) {
    console.warn(JSON.stringify({ event: "egress_client_rejected", remoteAddress: socket.remoteAddress }));
    socket.destroy();
  }
});
server.listen(port, host, () => console.log(JSON.stringify({ event: "egress_gateway_ready",
  network: networkName, host, port })));
