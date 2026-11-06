/** npm registry 上的版本选择与 tarball 获取。只下载、不安装。 */

import semver from "semver";
import { fetchVersionManifest, fetchTarball } from "./tarball.mjs";

export function pickVersion(packument, requested = null) {
  if (!packument || !packument.versions || typeof packument.versions !== "object") return null;
  if (requested) return packument.versions[requested] ? { version: requested, manifest: packument.versions[requested] } : null;
  const latest = packument["dist-tags"]?.latest;
  if (latest && packument.versions[latest]) return { version: latest, manifest: packument.versions[latest] };
  const stable = Object.keys(packument.versions).filter((v) => semver.valid(v) && !semver.prerelease(v));
  const pool = stable.length ? stable : Object.keys(packument.versions).filter((v) => semver.valid(v));
  pool.sort((a, b) => semver.rcompare(a, b));
  const version = pool[0];
  return version ? { version, manifest: packument.versions[version] } : null;
}

export async function downloadPackage(name, requestedVersion = null, options = {}) {
  const { version, manifest } = await fetchVersionManifest(name, requestedVersion);
  const tarballUrl = manifest?.dist?.tarball;
  if (!tarballUrl) throw new Error("版本缺少 dist.tarball：" + name + "@" + version);
  const files = await fetchTarball(tarballUrl, options);
  return { version, manifest, tarballUrl, files };
}
