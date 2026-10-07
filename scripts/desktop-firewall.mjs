import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { verifyHookOrder } from "./firewall-hook-order.mjs";

const [action, networkName = "desktop_default", portText = "3888", prefix = "OG_DESKTOP"] =
  process.argv.slice(2);
const port = Number(portText);
if (!["apply", "verify", "remove"].includes(action) || !/^[A-Za-z0-9_-]+$/.test(networkName) ||
  !Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Z][A-Z0-9_]{0,17}$/.test(prefix)) {
  throw new Error("Usage: node scripts/desktop-firewall.mjs apply|verify|remove [network] [gateway-port] [chain-prefix]");
}
if (process.getuid?.() !== 0) throw new Error("Run desktop-firewall.mjs as root");

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function iptables(...args) {
  return output("iptables", ["-w", ...args]);
}

function iptablesHas(...args) {
  return spawnSync("iptables", ["-w", ...args], { stdio: "ignore" }).status === 0;
}

const network = JSON.parse(output("docker", ["network", "inspect", networkName]))[0];
if (network.Driver !== "bridge" || network.EnableIPv6 || network.IPAM.Config.length !== 1) {
  throw new Error("Desktop firewall requires one IPv4-only bridge network");
}
const { Subnet: subnet, Gateway: gateway } = network.IPAM.Config[0];
const bridge = network.Options?.["com.docker.network.bridge.name"] || `br-${network.Id.slice(0, 12)}`;
if (!subnet || isIP(gateway) !== 4 || !existsSync(`/sys/class/net/${bridge}`)) {
  throw new Error("Desktop bridge subnet, gateway, or interface is unavailable");
}
const dns = [...new Set((process.env.OPENGROK_EGRESS_DNS_SERVERS ||
  readFileSync("/etc/resolv.conf", "utf8").split("\n")
    .filter(line => /^\s*nameserver\s+/.test(line)).map(line => line.trim().split(/\s+/)[1]).join(","))
  .split(",").filter(address => isIP(address) === 4 && !address.startsWith("127.")))];
if (!dns.length) throw new Error("No IPv4 upstream DNS server; set OPENGROK_EGRESS_DNS_SERVERS");

const fwd = `${prefix}_FWD`;
const input = `${prefix}_INPUT`;
const forwardHook = ["-i", bridge, "-s", subnet, "-j", fwd];
const inputHook = ["-i", bridge, "-s", subnet, "-j", input];
const forwardRules = [
  ...dns.flatMap(address => [
    ["-d", `${address}/32`, "-p", "udp", "--dport", "53", "-j", "RETURN"],
    ["-d", `${address}/32`, "-p", "tcp", "--dport", "53", "-j", "RETURN"],
  ]),
  ["-j", "REJECT"],
];
const inputRules = [
  ["-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"],
  ["-d", `${gateway}/32`, "-p", "tcp", "--dport", String(port), "-j", "RETURN"],
  ["-j", "REJECT"],
];

function chainRules(chain) {
  return iptables("-S", chain).split("\n").filter(line => line.startsWith(`-A ${chain} `));
}

function verify() {
  if (!iptablesHas("-C", "DOCKER-USER", ...forwardHook) ||
    !iptablesHas("-C", "INPUT", ...inputHook)) throw new Error("Desktop firewall hook is missing");
  for (const [chain, rules] of [[fwd, forwardRules], [input, inputRules]]) {
    const actual = chainRules(chain);
    if (actual.length !== rules.length) throw new Error(`${chain} rule count changed`);
    for (const rule of rules) {
      if (!iptablesHas("-C", chain, ...rule)) throw new Error(`${chain} rule missing: ${rule.join(" ")}`);
    }
    if (!actual.at(-1).includes(rules.at(-1).join(" "))) {
      throw new Error(`${chain} final rule changed`);
    }
  }
  verifyHookOrder(chainRules("DOCKER-USER"), "DOCKER-USER", subnet, bridge, fwd, "FWD");
  verifyHookOrder(chainRules("INPUT"), "INPUT", subnet, bridge, input, "INPUT");
}

function remove() {
  if (Object.keys(network.Containers || {}).length) {
    throw new Error("Stop every container on this network before removing firewall rules");
  }
  for (const [chain, hook, owner] of [["DOCKER-USER", forwardHook, fwd],
    ["INPUT", inputHook, input]]) {
    if (iptablesHas("-C", chain, ...hook)) iptables("-D", chain, ...hook);
    if (iptablesHas("-S", owner)) {
      iptables("-F", owner);
      iptables("-X", owner);
    }
  }
}

if (action === "apply") {
  if (iptablesHas("-S", fwd) || iptablesHas("-S", input)) {
    verify();
  } else {
    if (!iptablesHas("-S", "DOCKER-USER")) throw new Error("Docker DOCKER-USER chain is missing");
    try {
      iptables("-N", fwd);
      iptables("-N", input);
      for (const rule of forwardRules) iptables("-A", fwd, ...rule);
      for (const rule of inputRules) iptables("-A", input, ...rule);
      iptables("-I", "DOCKER-USER", "1", ...forwardHook);
      iptables("-I", "INPUT", "1", ...inputHook);
      verify();
    } catch (error) {
      if (iptablesHas("-C", "DOCKER-USER", ...forwardHook)) iptables("-D", "DOCKER-USER", ...forwardHook);
      if (iptablesHas("-C", "INPUT", ...inputHook)) iptables("-D", "INPUT", ...inputHook);
      for (const chain of [fwd, input]) {
        if (iptablesHas("-S", chain)) { iptables("-F", chain); iptables("-X", chain); }
      }
      throw error;
    }
  }
} else if (action === "verify") {
  verify();
} else {
  remove();
}
console.log(JSON.stringify({ action, network: networkName, bridge, subnet, gateway,
  gatewayPort: port, dns, chains: [fwd, input], status: "ok" }));
