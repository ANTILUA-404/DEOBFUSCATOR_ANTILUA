'use strict';

/**
 * Lightweight family fingerprints built from the terrorlua/obfuscator-samples
 * corpus. This is not a deobfuscator: it only lets the API name an unsupported
 * obfuscator instead of replying "unknown format" to every one of them.
 * Order matters — the more specific signatures come first.
 */
const FAMILIES = [
  { id: 'luraph', label: 'Luraph', test: /protected using Luraph Obfuscator/i },
  { id: 'prometheus', label: 'Prometheus', test: /return\s*\(\s*function\s*\(\s*\.\.\.\s*\)\s*local\s+\w+\s*=\s*\{\s*"/ },
  { id: 'synapsexen', label: 'SynapseXen', test: /SynapseXen_\w{6,}/ },
  { id: 'hercules', label: 'Hercules', test: /Obfuscated by Hercules v/i },
  { id: 'moonveil', label: 'MoonVeil', test: /generated using MoonVeil/i },
  { id: 'moonsec', label: 'MoonSec', test: /Protected_by_MoonSec/i },
  { id: 'psu', label: 'PSU Obfuscator', test: /obfuscated using PSU Obfuscator/i },
  { id: 'wYnFuscate', label: 'wYnFuscate', test: /Protected by wYnFuscate/i },
  { id: 'ironbrew3', label: 'Ironbrew3', test: /--\s*ironbrew3/i },
  { id: 'ironbrew1', label: 'Ironbrew1', test: /generated using ironbrew1/i },
  { id: 'boronide', label: 'Boronide', test: /herrtt'?s? obfuscator|herrtts obf/i },
  { id: '77fuscator', label: '77fuscator', test: /77fuscator\s+\d/i },
  { id: 'luaobfuscator', label: 'LuaObfuscator', test: /local\s+v0\s*=\s*string\.char\s*;\s*local\s+v1\s*=\s*string\.byte/ },
  { id: 'ironbrew2', label: 'IronBrew2', test: /local\s+K\s*=\s*string\.byte\s*;\s*local\s+N\s*=\s*string\.char[\s\S]{0,400}math\.ldexp/ },
];

function detectFamily(source) {
  const head = String(source || '').slice(0, 4000);
  for (const family of FAMILIES) {
    if (family.test.test(head)) {
      return { id: family.id, label: family.label };
    }
  }
  return null;
}

module.exports = { detectFamily, FAMILIES };
