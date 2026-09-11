import * as fs from "fs";
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const manifestBeta = JSON.parse(fs.readFileSync("manifest-beta.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));

const version = process.argv[2] || "patch";
const newVersion = bump(manifest.version, version);

manifest.version = newVersion;
manifestBeta.version = newVersion;
packageJson.version = newVersion;
versions[newVersion] = manifest.minAppVersion;

fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));
fs.writeFileSync("manifest-beta.json", JSON.stringify(manifestBeta, null, "\t"));
fs.writeFileSync("package.json", JSON.stringify(packageJson, null, "\t"));
fs.writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));

function bump(current, type) {
  const [major, minor, patch] = current.split(".").map((n) => parseInt(n, 10));
  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}
