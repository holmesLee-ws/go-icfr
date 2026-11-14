#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계, 국내 근거·글로벌 비교 칸(R10), 근거 키 대장 대조·공식 도메인·변동 칸(R11),
// 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교"];
const FORMAT = { capstone: "완료 조건" };
const OFFICIAL = ["law.go.kr", "fsc.go.kr", "fss.or.kr", "dart.fss.or.kr", "klca.or.kr", "k-icfr.org", "likms.assembly.go.kr", "kicpa.or.kr", "kasb.or.kr", "krx.co.kr", "korea.kr",
  "coso.org", "sec.gov", "ecfr.gov", "govinfo.gov", "congress.gov", "pcaobus.org", "iaasb.org", "ifac.org", "fsa.go.jp", "frc.org.uk", "gov.uk", "theiia.org"];
const KEY = /\[([KG]\d{2})\]/g;

function parseCurriculum(text) {
  const modules = new Map();
  const problems = [];
  const keysUsed = [];
  const noLaw = [];
  const blocks = text.split(/^### /m).slice(1).map((b) => b.split(/^## /m)[0]);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([FLDEX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2];
    }
    const isCapstone = id.startsWith("X");
    for (const name of FIELDS) if (!fields[name] && !(isCapstone && /근거|비교/.test(name))) problems.push(`${id}: 「${name}」 없음`);
    if (isCapstone && !fields[FORMAT.capstone]) problems.push(`${id}: 「${FORMAT.capstone}」 없음`);
    if (!isCapstone) {
      if (fields["국내 근거"] && ![...fields["국내 근거"].matchAll(KEY)].some((k) => k[1].startsWith("K"))) problems.push(`${id}: 국내 근거에 K 키 없음`);
      if (fields["글로벌 비교"] && ![...fields["글로벌 비교"].matchAll(KEY)].some((k) => k[1].startsWith("G"))) problems.push(`${id}: 글로벌 비교에 G 키 없음`);
    }
    if (fields["국내 근거"] && fields["국내 근거"].includes("법정 기준 없음")) noLaw.push(id);
    for (const v of Object.values(fields)) if (/제\d+조(의\d+)?(제\d+항)?\s*\([^)]*\)\s*[^\n]{80,}/.test(v) || /[「“"][^」”"\n]{60,}[」”"]/.test(v)) warnings.push(`${id}: 조문 원문으로 보이는 긴 인용(경고)`);
    keysUsed.push(...[...block.matchAll(KEY)].map((k) => [id, k[1]]));
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  if (noLaw.length) problems.push(`「법정 기준 없음」 모듈을 두지 않음(R10): ${noLaw.join(", ")}`);
  return { modules, problems, keysUsed };
}

function parseSources(text) {
  const rows = new Map();
  const problems = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\| ([KG]\d{2}) \|(.*)\|\s*$/);
    if (!m) continue;
    const cells = m[2].split("|").map((c) => c.trim());
    if (rows.has(m[1])) problems.push(`대장 ${m[1]}: 중복 키`);
    rows.set(m[1], cells);
    if (!(cells[5] || "").split(/\s+/).every((u) => /^https:\/\/\S+$/.test(u))) problems.push(`대장 ${m[1]}: URL 칸(7번째)이 공백으로 나눈 https URL이 아님`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[6] || "")) problems.push(`대장 ${m[1]}: 조회일 칸(8번째)이 날짜가 아님`);
    if (cells.some((c) => /미확인/.test(c))) problems.push(`대장 ${m[1]}: 미확인 항목은 대장에 두지 않음`);
    if (cells.length !== 8) problems.push(`대장 ${m[1]}: 칸 수 ${cells.length + 1}개(9개여야 함)`);
    else if (!/^(예 — .+|아니오)$/.test(cells[7])) problems.push(`대장 ${m[1]}: 변동 칸은 「예 — 이유」나 「아니오」`);
    for (const u of m[2].matchAll(/https?:\/\/([^/\s)]+)/g)) if (!OFFICIAL.some((d) => u[1] === d || u[1].endsWith(`.${d}`))) problems.push(`대장 ${m[1]}: 공식 도메인 아님 ${u[1]}`);
  }
  return { rows, problems };
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/.*\.m?js$/;
  return files.filter((f) => /\.(html?|css|svg|png|jpe?g|gif|webp|avif)$/i.test(f) || (/\.m?js$/i.test(f) && !allowedJs.test(f)));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, problems, keysUsed } = parseCurriculum(read("curriculum/map.md"));
  errors.push(...problems);
  const src = parseSources(read("curriculum/sources.md"));
  errors.push(...src.problems);
  for (const [id, k] of keysUsed) if (!src.rows.has(k)) errors.push(`${id}: 대장에 없는 근거 키 ${k}`);
  for (const k of src.rows.keys()) if (!keysUsed.some(([, u]) => u === k)) errors.push(`대장 ${k}: 커리큘럼에서 쓰지 않음`);
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  for (const w of warnings) console.warn(`WARN ${w}`);
  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 근거 ${src.rows.size}건, 파일 ${files.length}개 검사`);
}

main();
