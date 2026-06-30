// webauthn.js
// Browser side of passkey enrolment + passwordless ("biometric") login. The server
// (routes/auth.js) issues the challenges and verifies the signatures; this file runs
// the navigator.credentials ceremony and converts to/from the base64url JSON the
// server speaks. No third-party library is needed: the small conversions below are
// everything WebAuthn requires. Exposed as window.OBPasskey.
(function () {
  // WebAuthn is usable at all only when the platform exposes the credentials API.
  function supported() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create && navigator.credentials.get);
  }
  // Is a built-in biometric / device-PIN authenticator (Face ID, Touch ID, Windows
  // Hello, Android) actually available? Used to decide whether to surface the buttons.
  function platformAvailable() {
    try {
      if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return Promise.resolve(false);
      return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  // base64url <-> ArrayBuffer. The WebAuthn JS API speaks ArrayBuffers; our JSON
  // wire format speaks base64url. These are the only glue needed.
  function b64urlToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    var pad = s.length % 4;
    if (pad === 2) s += '==';
    else if (pad === 3) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function bufToB64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Enrol a new passkey for the logged-in user. label is an optional friendly name.
  async function enroll(label) {
    if (!supported()) throw new Error('This browser does not support passkeys.');
    var optionsJSON = await API.passkeyRegisterOptions();
    var publicKey = Object.assign({}, optionsJSON);
    publicKey.challenge = b64urlToBuf(optionsJSON.challenge);
    publicKey.user = Object.assign({}, optionsJSON.user, { id: b64urlToBuf(optionsJSON.user.id) });
    if (Array.isArray(optionsJSON.excludeCredentials)) {
      publicKey.excludeCredentials = optionsJSON.excludeCredentials.map(function (c) {
        return Object.assign({}, c, { id: b64urlToBuf(c.id) });
      });
    }
    var cred = await navigator.credentials.create({ publicKey: publicKey });
    if (!cred) throw new Error('No passkey was created.');
    var r = cred.response;
    var out = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(r.clientDataJSON),
        attestationObject: bufToB64url(r.attestationObject),
        transports: (r.getTransports ? r.getTransports() : []) || [],
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
    if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
    return await API.passkeyRegisterVerify(out, label || '');
  }

  // Passwordless login: the device offers its saved OpenBook passkeys; the chosen one
  // signs the challenge. Returns the API response ({ user }).
  async function login(fp) {
    if (!supported()) throw new Error('This browser does not support passkeys.');
    var optionsJSON = await API.passkeyAuthOptions();
    var publicKey = Object.assign({}, optionsJSON);
    publicKey.challenge = b64urlToBuf(optionsJSON.challenge);
    if (Array.isArray(optionsJSON.allowCredentials)) {
      publicKey.allowCredentials = optionsJSON.allowCredentials.map(function (c) {
        return Object.assign({}, c, { id: b64urlToBuf(c.id) });
      });
    }
    var assertion = await navigator.credentials.get({ publicKey: publicKey });
    if (!assertion) throw new Error('No passkey was selected.');
    var r = assertion.response;
    var out = {
      id: assertion.id,
      rawId: bufToB64url(assertion.rawId),
      type: assertion.type,
      response: {
        clientDataJSON: bufToB64url(r.clientDataJSON),
        authenticatorData: bufToB64url(r.authenticatorData),
        signature: bufToB64url(r.signature),
        userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined,
      },
      clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {},
    };
    if (assertion.authenticatorAttachment) out.authenticatorAttachment = assertion.authenticatorAttachment;
    return await API.passkeyAuthVerify(out, fp || '');
  }

  window.OBPasskey = { supported: supported, platformAvailable: platformAvailable, enroll: enroll, login: login };
})();
