// vflow R-ID trace chain — parsing and coverage checks.

const RID_DEF = /^\s*-\s*(R\d+)\s*[:：][ \t]*\S/gm;
const RID_REF = /[（(](R\d+(?:\s*[,，、]\s*R\d+)*)[)）]/g;

export function parseRidDefinitions(text: string): Set<string> {
  const rids = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(RID_DEF.source, RID_DEF.flags);
  while ((m = re.exec(text)) !== null) {
    rids.add(m[1]);
  }
  return rids;
}

export function parseRidReferences(text: string): Set<string> {
  const rids = new Set<string>();
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!(s.startsWith('- [ ]') || s.startsWith('- [x]') || s.startsWith('- [X]'))) continue;
    const re = new RegExp(RID_REF.source, RID_REF.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      for (const rid of m[1].split(/[,，、]/)) {
        rids.add(rid.trim());
      }
    }
  }
  return rids;
}

function setDiff(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const x of a) if (!b.has(x)) result.add(x);
  return result;
}

export function checkRidCoverage(
  required: Set<string>,
  covered: Set<string>,
  docName: string,
): [boolean, string[]] {
  const missing = [...setDiff(required, covered)].sort(
    (a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)),
  );
  const extra = [...setDiff(covered, required)].sort(
    (a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)),
  );
  const msgs: string[] = [];
  for (const rid of missing) msgs.push(`missing ${rid} in ${docName}`);
  for (const rid of extra) msgs.push(`warning: ${rid} in ${docName} is not defined in requirement.md`);
  return [missing.length === 0, msgs];
}

export function verifySection(text: string, sectionNo: number): string {
  const pattern = new RegExp(
    `^##\\s*§${sectionNo}\\b.*?$(.*?)(?=^##\\s|$(?![\\s\\S]))`,
    'ms',
  );
  const m = pattern.exec(text);
  return m ? m[1] : '';
}
