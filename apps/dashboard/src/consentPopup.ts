/**
 * Open a provider's consent or install screen in a popup and resolve when the
 * callback page reports back.
 *
 * A popup rather than a full-page redirect so the user keeps the screen they
 * were on. The callback page posts a message and closes itself; the polling
 * fallback covers the case where the user closes the popup by hand, which would
 * otherwise leave this promise pending forever.
 *
 * Extracted from the Integrations gallery when the deploy-target form needed
 * the same flow: a PR target cannot work until the customer installs Engine's
 * GitHub App, and asking for that from the form has to run the one flow that
 * records a connection, not a second copy of it.
 */
export function openConsentPopup(url: string): Promise<'connected' | 'cancelled' | 'closed'> {
  return new Promise((resolve) => {
    const popup = window.open(url, 'engine-provider-consent', 'width=520,height=680');
    if (!popup) {
      // Popup blocked. Falling back to the current tab is better than silently
      // doing nothing; the callback page offers a link back.
      window.location.href = url;
      resolve('closed');
      return;
    }

    let settled = false;
    const finish = (outcome: 'connected' | 'cancelled' | 'closed') => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      resolve(outcome);
    };

    function onMessage(event: MessageEvent) {
      const data = event.data as { source?: string; status?: string } | null;
      if (!data || data.source !== 'engine-oauth') return;
      finish(data.status === 'connected' ? 'connected' : 'cancelled');
    }

    window.addEventListener('message', onMessage);
    const poll = setInterval(() => {
      if (popup.closed) finish('closed');
    }, 500);
  });
}
