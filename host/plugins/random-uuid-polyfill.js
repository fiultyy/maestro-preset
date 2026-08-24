// Polyfill crypto.randomUUID for insecure origins (LAN over plain HTTP).
// Browsers only expose crypto.randomUUID in secure contexts; dsh's client
// connection plugin (message/RPC ids) calls it unconditionally.
// getRandomValues IS available in insecure contexts, so this restores parity.
export const name = 'random-uuid-polyfill'
export const inject = ['webServer']

const snippet =
  '<script>' +
  'window.__dshPolyRan=true;' +
  'if(!crypto.randomUUID){' +
  'Object.defineProperty(crypto,"randomUUID",{value:function(){' +
  'var b=crypto.getRandomValues(new Uint8Array(16));' +
  'b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;' +
  'var h=Array.from(b,function(x){return x.toString(16).padStart(2,"0")}).join("");' +
  'return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)' +
  '},configurable:true,writable:true});}' +
  '<\/script>'

export function apply(ctx) {
  ctx.webServer.tapIndex((html) => html.replace('<head>', '<head>' + snippet))
}
