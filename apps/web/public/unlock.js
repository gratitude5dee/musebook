// apps/web/public/unlock.js — the kernel teaser document's progressive
// enhancement (§14.2.10): a stable, non-fingerprinted ES module that upgrades
// the .musebook-paywall link into the in-place unlock flow when the reader
// already has an injected wallet. Vanilla JS — no bundler, no _next/static.
(() => {
  const wall = document.querySelector(".musebook-paywall");
  const eth = globalThis.ethereum;
  if (wall === null || eth === undefined || eth === null) return;

  const link = wall.querySelector("a[href^='/pay/']");
  if (link === null) return;
  const postId = link.getAttribute("href").split("/").pop();
  const slug = location.pathname.startsWith("/p/") ? location.pathname.slice(3) : null;
  if (slug === null) return;

  const setStatus = (text) => {
    let el = wall.querySelector("[data-unlock-status]");
    if (el === null) {
      el = document.createElement("p");
      el.setAttribute("data-unlock-status", "");
      el.setAttribute("aria-live", "assertive");
      wall.appendChild(el);
    }
    el.textContent = text;
  };

  const b64 = (obj) =>
    btoa(JSON.stringify(obj)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

  const hex = (n) => "0x" + Array.from(n, (b) => b.toString(16).padStart(2, "0")).join("");

  link.addEventListener("click", async (ev) => {
    ev.preventDefault();
    setStatus("Requesting…");
    const probe = await fetch(`/p/${slug}.json`, { headers: { accept: "application/json" } });
    if (probe.status !== 402) {
      location.reload();
      return;
    }
    const required = JSON.parse(
      atob(probe.headers.get("PAYMENT-REQUIRED").replaceAll("-", "+").replaceAll("_", "/")),
    );
    const chosen = required.accepts[0];
    const chainId = Number(chosen.network.split(":")[1]);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const validBefore = String(Math.floor(Date.now() / 1000) + chosen.maxTimeoutSeconds);
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    const from = accounts[0];
    setStatus("Sign in your wallet");
    // EIP-3009 over the offer's own domain fields — never hardcode them.
    const signature = await eth.request({
      method: "eth_signTypedData_v4",
      params: [
        from,
        JSON.stringify({
          domain: {
            name: chosen.extra.name,
            version: chosen.extra.version,
            chainId,
            verifyingContract: chosen.asset,
          },
          primaryType: "TransferWithAuthorization",
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            TransferWithAuthorization: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
            ],
          },
          message: {
            from,
            to: chosen.payTo,
            value: chosen.amount,
            validAfter: "0",
            validBefore,
            nonce,
          },
        }),
      ],
    });
    setStatus("Settling on Base…");
    const paid = await fetch(`/p/${slug}.json`, {
      headers: {
        accept: "application/json",
        "PAYMENT-SIGNATURE": b64({
          x402Version: 2,
          accepted: chosen,
          payload: {
            signature,
            authorization: {
              from,
              to: chosen.payTo,
              value: chosen.amount,
              validAfter: "0",
              validBefore,
              nonce,
            },
          },
        }),
      },
    });
    if (paid.ok) {
      location.reload();
      return;
    } // reload shows the paid body
    setStatus("Payment didn't go through — try again.");
  });
})();
