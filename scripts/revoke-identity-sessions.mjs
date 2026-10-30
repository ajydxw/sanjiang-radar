import { createIdentitySessionStore } from './identity-sessions.mjs';

await (await createIdentitySessionStore()).clear();
console.log('本机保存的身份会话已撤销；用户下次访问时需要重新确认。');
