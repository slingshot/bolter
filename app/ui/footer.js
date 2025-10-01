const html = require('choo/html');
const Component = require('choo/component');

class Footer extends Component {
  constructor(name, state) {
    super(name);
    this.state = state;
  }

  update() {
    return false;
  }

  createElement() {
    const translate = this.state.translate;

    // Add additional links from configuration if available
    var links = [];
    if (this.state != undefined && this.state.WEB_UI != undefined) {
      const WEB_UI = this.state.WEB_UI;

      links.push(html`
        <li class="m-2">
          <a href="mailto:help@slingshot.fm" target="_blank">
            Support
          </a>
        </li>
      `);

      if (WEB_UI.FOOTER_DONATE_URL != '') {
        links.push(html`
          <li class="m-2">
            <a href="${WEB_UI.FOOTER_DONATE_URL}" target="_blank">
              ${translate('footerLinkDonate')}
            </a>
          </li>
        `);
      }
      // if (WEB_UI.FOOTER_CLI_URL != '') {
      //   links.push(html`
      //     <li class="m-2">
      //       <a href="${WEB_UI.FOOTER_CLI_URL}" target="_blank">
      //         ${translate('footerLinkCli')}
      //       </a>
      //     </li>
      //   `);
      // }
      if (WEB_UI.FOOTER_DMCA_URL != '') {
        links.push(html`
          <li class="m-2">
            <a href="${WEB_UI.FOOTER_DMCA_URL}" target="_blank">
              ${translate('footerLinkDmca')}
            </a>
          </li>
        `);
      }
      if (WEB_UI.FOOTER_SOURCE_URL != '') {
        links.push(html`
          <li class="m-2">
            <a href="${WEB_UI.FOOTER_SOURCE_URL}" target="_blank">
              ${translate('footerLinkSource')}
            </a>
          </li>
        `);
      }
    } else {
      links.push(html`
        <li class="m-2">
          <a href="https://github.com/slingshot/bolter" target="_blank">
            ${translate('footerLinkSource')}
          </a>
        </li>
      `);
    }

    // Defining a custom footer
    var footer = [];
    if (this.state != undefined && this.state.WEB_UI != undefined) {
      const WEB_UI = this.state.WEB_UI;

      if (WEB_UI.CUSTOM_FOOTER_URL != '' && WEB_UI.CUSTOM_FOOTER_TEXT != '') {
        footer.push(html`
          <li class="m-2">
            <a href="${WEB_UI.CUSTOM_FOOTER_URL}" target="_blank">
              ${WEB_UI.CUSTOM_FOOTER_TEXT}
            </a>
          </li>
        `);
      } else if (WEB_UI.CUSTOM_FOOTER_URL != '') {
        footer.push(html`
          <li class="m-2">
            <a href="${WEB_UI.CUSTOM_FOOTER_URL}" target="_blank">
              ${WEB_UI.CUSTOM_FOOTER_URL}
            </a>
          </li>
        `);
      } else if (WEB_UI.CUSTOM_FOOTER_TEXT != '') {
        footer.push(html`
          <li class="m-2">
            ${WEB_UI.CUSTOM_FOOTER_TEXT}
          </li>
        `);
      } else {
        footer.push(html`
          <li class="m-2">
            ${translate('footerText')}
          </li>
        `);
      }
    }

    // Terms/Privacy
    footer.push(html`
      <li class="m-2">
        <a href="https://legal.slingshot.fm/send-terms-2507b" target="_blank">
          Terms
        </a>
      </li>
    `);
    footer.push(html`
      <li class="m-2">
        <a href="https://legal.slingshot.fm/send-privacy-2507a" target="_blank">
          Privacy
        </a>
      </li>
    `);

    return html`
      <footer
        class="flex flex-col md:flex-row items-start w-full flex-none self-start p-6 md:p-8 font-medium text-xs text-grey-60 dark:text-grey-40 md:items-center justify-between"
      >
        <ul
          class="flex flex-col md:flex-row items-start md:items-center md:justify-start"
        >
          ${footer}
        </ul>
        <ul
          class="flex flex-col md:flex-row items-start md:items-center md:justify-end"
        >
          ${links}
        </ul>
      </footer>
    `;
  }
}

module.exports = Footer;
