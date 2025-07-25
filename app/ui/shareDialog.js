const html = require('choo/html');

module.exports = function(name, url, encrypted = true) {
  const dialog = function(state, emit, close) {
    const messageKey = encrypted
      ? 'notifyUploadEncryptDone'
      : 'notifyUploadDone';
    return html`
      <send-share-dialog
        class="flex flex-col items-center text-center p-4 max-w-sm m-auto"
      >
        <h1 class="text-3xl font-medium my-4">
          ${state.translate(messageKey)}
        </h1>
        <p
          class="font-normal leading-normal text-grey-80 word-break-all dark:text-grey-40"
        >
          ${state.translate('shareLinkDescription')}<br />
          ${name}
        </p>
        <input
          type="text"
          id="share-url"
          class="w-full my-4 border-default rounded-lg leading-loose h-12 px-2 py-1 dark:bg-grey-80"
          value="${url}"
          readonly="true"
        />
        <button
          class="btn rounded-lg w-full flex-shrink-0 focus:outline"
          onclick="${share}"
          title="${state.translate('shareLinkButton')}"
        >
          ${state.translate('shareLinkButton')}
        </button>
        <button
          class="link-primary my-4 font-medium cursor-pointer focus:outline"
          onclick="${close}"
          title="${state.translate('okButton')}"
        >
          ${state.translate('okButton')}
        </button>
      </send-share-dialog>
    `;

    async function share(event) {
      event.stopPropagation();
      try {
        await navigator.share({
          title: state.translate('-send-brand'),
          // text: state.translate('shareMessage', { name }),
          url
        });
      } catch (e) {
        if (e.code === e.ABORT_ERR) {
          return;
        }
        console.error(e);
      }
      close();
    }
  };
  dialog.type = 'share';
  return dialog;
};
