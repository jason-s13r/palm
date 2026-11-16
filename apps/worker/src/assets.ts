// A 96 px placeholder avatar (a circle on a soft green ground), served at
// /palm/avatar.png on every host until accounts can upload their own.
const AVATAR_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABBUlEQVR42u3cwRHCMAwEQFVEQfRCd3zpgVJoAPLAlmMpO3MV7CsT3Tme75ccJBAAAgQIECBAgAAJIECAAAECBAiQAKoFdHvcv+a6QL9EjnMJoP9oTmSKQjSnMEU5msVMUZRmGVNU18k2igY6qUbRQyfPKNroJBlFJ50Mo2imM90o+unMNQK0BGg3nYlGgPKB9tSZZQQoGWhnnSlGgDKB9tcZNwIECBCgmkBVdAaNAAECBAgQIECAfCgCAgQIUDEgv1wBOfsAcnp2m28ApP4CSAVPiVMNuEINWJHcFMGYxRzKoM4ks9kk06jXLNzDAgIIECBAgAABAiSAAAECBAgQIEACCNB4PtYEbAhiqGrbAAAAAElFTkSuQmCC";

export function avatarResponse(): Response {
  const bytes = Uint8Array.from(atob(AVATAR_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}
