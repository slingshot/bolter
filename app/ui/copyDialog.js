const html = require('choo/html');
const { copyToClipboard } = require('../utils');
const qr = require('./qr');

module.exports = function(name, url, encrypted = true) {
  const dialog = function(state, emit, close) {
    const messageKey = encrypted
      ? 'notifyUploadEncryptDone'
      : 'notifyUploadDone';
    return html`
      <send-copy-dialog
        class="flex flex-col items-center text-center p-4 max-w-sm m-auto"
      >
        <h1 class="text-3xl font-medium my-4">
          ${state.translate(messageKey)}
        </h1>
        <p
          class="font-normal leading-normal text-grey-80 word-break-all dark:text-grey-40"
        >
          ${state.translate('copyLinkDescription')} <br />
          ${name}
        </p>
        <div class="flex flex-row items-center justify-center w-full">
          <input
            type="text"
            id="share-url"
            class="block w-full my-4 border-default rounded-lg leading-loose h-12 px-2 py-1 dark:bg-grey-80"
            value="${url}"
            readonly="true"
          />
          <button
            id="qr-btn"
            class="w-16 m-1 p-1"
            onclick="${toggleQR}"
            title="QR code"
          >
            ${qr(url)}
          </button>
        </div>
        <button
          class="btn rounded-lg w-full flex-shrink-0 focus:outline"
          onclick="${copy}"
          title="${state.translate('copyLinkButton')}"
        >
          ${state.translate('copyLinkButton')}
        </button>
        <button
          class="link-primary my-4 font-medium cursor-pointer focus:outline"
          onclick="${close}"
          title="${state.translate('okButton')}"
        >
          ${state.translate('okButton')}
        </button>
      </send-copy-dialog>
    `;

    function toggleQR(event) {
      event.stopPropagation();
      const shareUrl = document.getElementById('share-url');
      const qrBtn = document.getElementById('qr-btn');
      if (shareUrl.classList.contains('hidden')) {
        shareUrl.classList.replace('hidden', 'block');
        qrBtn.classList.replace('w-48', 'w-16');
      } else {
        shareUrl.classList.replace('block', 'hidden');
        qrBtn.classList.replace('w-16', 'w-48');
      }
    }

    function copy(event) {
      event.stopPropagation();
      copyToClipboard(url);
      event.target.textContent = state.translate('copiedUrl');
      setTimeout(close, 1000);
    }
  };
  dialog.type = 'copy';
  return dialog;
};
