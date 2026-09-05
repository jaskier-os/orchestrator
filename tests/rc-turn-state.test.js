// Unit test for turnStateOf via getActiveSessions: a session with a thinking
// timestamp or an in-flight tool must report thinking=true; an idle one false.
import { __registerSessionForTest, getActiveSessions } from '../src/rc-handler.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('PASS ', name); pass++; }
  else { console.log('FAIL ', name); fail++; }
}
const base = () => ({
  pendingPermissions: new Map(), permissionMode: 'bypassAll',
  createdAt: new Date(), phoneDeviceId: null,
});

__registerSessionForTest('s-idle', { ...base() });
__registerSessionForTest('s-thinking', { ...base(), thinkingStartedAt: 1700000000000 });
__registerSessionForTest('s-tool', { ...base(), toolInFlight: new Map([['t1', {}]]) });

const by = Object.fromEntries(getActiveSessions().map(s => [s.sessionId, s]));
check('idle session reports thinking=false', by['s-idle'].thinking === false);
check('thinking session reports thinking=true', by['s-thinking'].thinking === true);
check('thinking session carries its start time', by['s-thinking'].thinkingStartedAt === 1700000000000);
check('a tool in flight counts as thinking', by['s-tool'].thinking === true);
check('idle reports no start time', by['s-idle'].thinkingStartedAt === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
