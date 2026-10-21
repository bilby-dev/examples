// Resolve the package groups in py/bootstrap.py against PyPI and write
// packages.lock.json: for each group, the Pyodide packages it loads and the
// exact PyPI wheels (file, URL, sha256, licence) it adds on top of the
// "bilby" group. The site installs only from this lock.
//
//   node scripts/lock-packages.mjs
//
// Needs the local wheels (scripts/dev.sh, or the fetch/build scripts).
// Each group is resolved in a fresh Pyodide with only the bilby group
// installed, so every group is complete on its own. The bilby group is
// locked for each version in bilby-versions.json (with that version's pins);
// the other groups are resolved against every version too, and must come out
// the same, so they are locked once.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = { lalsuite: "lalsuite-", igwn_segments: "igwn_segments-" };
const config = JSON.parse(readFileSync(join(ROOT, "bilby-versions.json"), "utf8"));
const built = JSON.parse(readFileSync(join(ROOT, "examples/versions.json"), "utf8")).versions;

// A Pyodide set up to resolve the groups for this entry of bilby-versions.json
async function freshPyodide(version) {
  const pyodide = await loadPyodide();
  pyodide.registerJsModule("_site", { image() {} });
  pyodide.runPython(readFileSync(join(ROOT, "py/bootstrap.py"), "utf8"));
  // the version's pins replace the bilby group's specs of the same packages
  pyodide.runPython(`
import re
_pins = ${JSON.stringify(version.pins ?? [])}
_name = lambda spec: re.split(r"[=<>!~ \\[]", spec)[0].lower()
GROUPS["bilby"]["pypi"] = [s for s in GROUPS["bilby"]["pypi"] if _name(s) not in {_name(p) for p in _pins}] + _pins
`);
  pyodide.FS.mkdirTree("/tmp/wheels");
  const bilbyWheel = built.find((v) => v.name === version.name)?.wheel;
  if (!bilbyWheel) throw new Error(`no wheel for bilby ${version.name}; run scripts/fetch-bilby.sh first`);
  pyodide.FS.writeFile(`/tmp/wheels/${bilbyWheel}`, readFileSync(join(ROOT, "wheels", bilbyWheel)));
  const urls = { bilby: `emfs:/tmp/wheels/${bilbyWheel}` };
  for (const [key, prefix] of Object.entries(LOCAL)) {
    const wheel = readdirSync(join(ROOT, "wheels")).filter((f) => f.startsWith(prefix) && f.endsWith(".whl")).sort().pop();
    if (!wheel) throw new Error(`no ${prefix}*.whl in wheels/; run scripts/dev.sh first`);
    pyodide.FS.writeFile(`/tmp/wheels/${wheel}`, readFileSync(join(ROOT, "wheels", wheel)));
    urls[key] = `emfs:/tmp/wheels/${wheel}`;
  }
  const pyUrls = pyodide.toPy(urls);
  pyodide.globals.get("set_lock")(null, "", pyUrls);
  pyUrls.destroy();
  return pyodide;
}

// {name: {version, source}} of everything installed
function installed(pyodide) {
  return pyodide.runPython(`
import micropip
{name: {"version": p.version, "source": p.source} for name, p in micropip.list().items()}
`).toJs({ dict_converter: Object.fromEntries });
}

// Packages whose PyPI metadata has no licence, checked by hand against the
// licence file in the wheel.
const LICENSE_OVERRIDES = { dynesty: "MIT" };

async function pypiWheel(name, version) {
  const response = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
  if (!response.ok) throw new Error(`PyPI has no ${name} ${version}`);
  const data = await response.json();
  const wheel = data.urls.find((u) => u.packagetype === "bdist_wheel" && /-none-any\.whl$/.test(u.filename));
  if (!wheel) throw new Error(`${name} ${version} has no pure-Python wheel on PyPI`);
  const info = data.info;
  const classifier = (info.classifiers || []).filter((c) => c.startsWith("License ::")).map((c) => c.split(" :: ").pop());
  const license = LICENSE_OVERRIDES[name] || info.license_expression || (info.license && info.license.length < 80 ? info.license : "") || classifier.join(", ") || "see package";
  return { name, version, file: wheel.filename, url: wheel.url, sha256: wheel.digests.sha256, license };
}

async function lockGroup(name, version) {
  const pyodide = await freshPyodide(version);
  const install = pyodide.globals.get("install_group");
  if (name !== "bilby") await install("bilby");
  const before = name === "bilby" ? {} : installed(pyodide);
  await install(name);
  const after = installed(pyodide);
  const added = Object.entries(after).filter(([pkg, info]) => !(pkg in before) || before[pkg].version !== info.version);
  const pyodidePackages = added.filter(([, info]) => info.source === "pyodide").map(([pkg]) => pkg).sort();
  const pypi = [];
  for (const [pkg, info] of added) {
    if (info.source === "pyodide" || info.source.startsWith("emfs:")) continue; // Pyodide or our local wheels
    pypi.push(await pypiWheel(pkg, info.version));
  }
  pypi.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`bilby ${version.name}, ${name}: ${pyodidePackages.length} Pyodide packages, ${pypi.length} PyPI wheels`);
  return { pyodide: pyodidePackages, pypi, pyodideVersion: pyodide.version };
}

const bilby = {};
const groups = {};
let pyodideVersion;
const names = Object.keys((await freshPyodide(config.versions[0])).globals.get("GROUPS").toJs({ dict_converter: Object.fromEntries }));
for (const version of config.versions) {
  for (const name of names) {
    const { pyodideVersion: v, ...group } = await lockGroup(name, version);
    pyodideVersion = v;
    if (name === "bilby") {
      bilby[version.name] = group;
    } else if (!(name in groups)) {
      groups[name] = group;
    } else if (JSON.stringify(group) !== JSON.stringify(groups[name])) {
      throw new Error(`the ${name} group resolves differently with bilby ${version.name} than with ` +
        `${config.versions[0].name}; lock it per version like the bilby group`);
    }
  }
}
const lock = { pyodide_version: pyodideVersion, generated_by: "scripts/lock-packages.mjs", bilby, groups };
writeFileSync(join(ROOT, "packages.lock.json"), JSON.stringify(lock, null, 1) + "\n");
console.log("wrote packages.lock.json");
process.exit(0);
