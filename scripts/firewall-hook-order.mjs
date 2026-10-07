export function verifyHookOrder(rules, chain, subnet, bridge, target, suffix) {
  const position = rules.indexOf(`-A ${chain} -s ${subnet} -i ${bridge} -j ${target}`);
  if (position < 0) throw new Error(`${chain} desktop hook changed`);
  const otherBridgeHook = new RegExp(
    `^-A ${chain} -s [0-9.]+/[0-9]+ -i ([A-Za-z0-9_.-]+) -j OG_[A-Z0-9_]+_${suffix}$`,
  );
  for (const rule of rules.slice(0, position)) {
    const match = rule.match(otherBridgeHook);
    if (!match || match[1] === bridge) {
      throw new Error(`${chain} has a rule that can precede the desktop hook`);
    }
  }
}
