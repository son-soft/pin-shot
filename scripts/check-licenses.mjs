import fs from 'node:fs';
import {createHash} from 'node:crypto';

const inputs = JSON.parse(fs.readFileSync('licenses/inputs.json','utf8'));
for (const [file, hash] of Object.entries(inputs)) {
  if (createHash('sha256').update(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n')).digest('hex') !== hash) {
    throw Error(`License inventory is stale for ${file}. Run pnpm licenses:generate and review the changes.`);
  }
}
const entries = JSON.parse(fs.readFileSync('licenses/dependencies.json','utf8'));
for (const entry of entries) {
  if (!entry.license || !entry.notices.length) throw Error(`Missing license: ${entry.name}`);
  for (const notice of entry.notices) {
    const text = fs.readFileSync(`licenses/${notice.file}`,'utf8').replaceAll('\r\n','\n');
    const expected = notice.file.split('/').pop().replace('.txt','');
    if (createHash('sha256').update(text).digest('hex') !== expected) throw Error(`Notice changed: ${notice.file}`);
  }
}
for (const file of ['LICENSE','THIRD_PARTY_NOTICES.md','licenses/upstream/onnxruntime-LICENSE.txt','licenses/upstream/onnxruntime-ThirdPartyNotices.txt','licenses/upstream/PaddleOCR-LICENSE.txt','licenses/upstream/RapidOCR-LICENSE.txt']) {
  if (!fs.statSync(file).size) throw Error(`Empty license file: ${file}`);
}
console.log(`License inventory verified: ${entries.length} dependency entries.`);
