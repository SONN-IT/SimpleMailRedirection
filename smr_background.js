//debug("background started");
let prefs = { debug: false };
var screen;

var redirect = {
  msgs: null,
  getAddress: async function (type, info, info2) {
    debug('got Addresses, type=' + type);
    //debug('info: '+JSON.stringify(info));
    //debug('info2: '+JSON.stringify(info2));
    this.msgs = null;
    let ml = null;
    let curTab = null;
    if (type == 'keyboard') {	//keyboard shortcut pressed
      debug('keyboard shortcut pressed');
      curTab = (await messenger.tabs.query({
        active: true,
        currentWindow: true,
      }))[0];
      /*
            const curWin = await messenger.windows.getCurrent();
            curTab = (await messenger.tabs.query({
              active: true,
              windowId: curWin.id
            }))[0];
      */
      //debug('queried tabId='+curTab.id+' is a mailTab: '+curTab.mailTab+' or type='+curTab.type);
    } else if (type == 'contextMenu') {
      //if called from message list context menu, we get 'selectedMessages' in info, info2 is a tab
      //if called from a message display context menu, we get a 'pageUrl' in info, info2 is a tab
      //if called from message display action button, info is a tab, info2 is OnClickData
      //if called from browser action button, info is a tab, info2 is OnClickData
      //debug('context menu: tabId='+info2.id+' is a mailTab: '+info2.mailTab+' or type='+info2.type);
      if (info.menuItemId == 'smr_redirect_mail') {
        debug('via context menu in message list');
        ml = info.selectedMessages;
      } else if (info.menuItemId == 'smr_redirect_msg') {
        debug('via context menu in a messageDisplay');
        this.msgs = await messenger.messageDisplay.getDisplayedMessages(info2.id);
      }
      else { return; }
    } else if (type == 'browserAction') {
      debug('via browser action button');
      curTab = info;
    } else if (type == 'messageDisplayAction') {
      debug('via displayMessage action button');
      this.msgs = await messenger.messageDisplay.getDisplayedMessages(info.id);
    } else {
      console.error('SMR: could not redirect if TB started via .eml file');
      debug('no msg, started via .eml?');
      this.msgs = [];
    }

    if (curTab) {
      if (curTab?.mailTab) {
        debug(' in a mail tab');
        ml = await messenger.mailTabs.getSelectedMessages(curTab.id);
      } else if (curTab?.type == 'messageDisplay') {
        debug(' in a message display');
        this.msgs = await messenger.messageDisplay.getDisplayedMessages(curTab.id);
      } else {
        return
      }
    }
    if (ml) {
      this.msgs = ml.messages;
      while (ml.id) {
        //debug('get next page of messages');
        ml = await messenger.messages.continueList(ml.id);
        this.msgs = this.msgs.concat(ml.messages);
      }
    }

    // open popup window
    if (this.msgs.length > 0) {
      debug('num of messages=' + this.msgs.length);
      /*
      this.msgs.forEach( async mh => {
      //debug('mh='+JSON.stringify(mh));
      debug('got message id='+mh.id+' '+mh.subject+' ('+mh.author+')');
      });
      */
      //id=1 folder={"accountId":"account1","name":"Posteingang","path":"/INBOX","type":"inbox"}
      messenger.runtime.onMessage.addListener(this.handleMessage);
      let pos = await messenger.storage.local.get([
        "top",
        "left",
        "height",
        "width",
        "size",
      ]);
      debug("pos=" + JSON.stringify(pos));

      let minHeight = 300 + (this.msgs.length > 5 ? 150 : this.msgs.length * 30);
      let minWidth = 900;
      debug("minHeight=" + minHeight + " minWidth=" + minWidth);

      let height = pos.height ? Math.max(pos.height, minHeight) : minHeight;
      let width = pos.width ? Math.max(pos.width, minWidth) : minWidth;
      debug("creation height=" + height + " width=" + width);
      //if (height<pos.height) height=pos.height;
      let win = await messenger.windows.create({
        height: height,
        width: width,
        allowScriptsToClose: true,
        url: "ui/RedirectWindow.html",
        type: "popup",
        //'normal' opens  new mail:3pane window with smr as additional tab
      });

      debug('screen=' + screen.width + 'x' + screen.height);
      debug('pos=' + pos.width + 'x' + height + ' at ' + pos.left + 'x' + pos.top);
      if (pos.top > 0 && pos.top + height < screen.height && pos.left > 0 && pos.left + pos.width < screen.width) {
        debug('positioned window to ' + pos.left + 'x' + pos.top);
        await messenger.windows.update(win.id, {
          top: pos.top,
          left: pos.left,
        });
      }
      /*
            let t=await messenger.tabs.create({
              active: true,
              url: "/smr_addresses.html"
            });
      */
      //TODO: get real window for w.id
      //TODO: window,resizeTo(width, height) oder window.resizeBy(xDelta, yDelta)  im implementation

    } else {
      console.log('SMR: No message selected');
    }
    return;
  },

  handleMessage: function (request, sender, sendResponse) {
    //debug('request='+JSON.stringify(request)+' sender='+sender);
    if (request && request.action) switch (request.action) {
      case 'requestData':      // send info about selected messages to popup
        prefs = request.prefs;
        debug('requestData, send messages, prefs now ' + JSON.stringify(prefs));
        sendResponse(redirect.msgs);
        break;
    }
    return true;
  }

}

async function start() {
  debug('background started');
  prefs = await messenger.storage.local.get({ debug: false });
  //dont use storage.local.get() (without arg), see https://thunderbird.topicbox.com/groups/addons/T46e96308f41c0de1
  let resent = messenger.i18n.getMessage('resent');
  // shown in context menu of message list
  messenger.menus.create({
    contexts: ["message_list"],
    id: "smr_redirect_mail",
    title: resent
    //    ,icons: {16: "skin/SimpleMailRedirection.svg"}  //not working on main menu item :-(
  });
  // shown in context menu of all messages, but need to get current message as no messages selected
  // returns a "pageUrl":"imap://mail.davbs.de:993/fetch%3EUID%3E.INBOX%3E10617"
  messenger.menus.create({
    contexts: ["page"],	//no: frame, tab, selection, browser_action
    //documentUrlPatterns: ["*://*/*"],	//["imap-message://*/*"],
    //viewTypes: ['popup'],
    id: "smr_redirect_msg",
    title: resent
    //    ,icons: {16: "skin/SimpleMailRedirection.svg"}  //not working on main menu item :-(
  });
  messenger.menus.onClicked.addListener(redirect.getAddress.bind(redirect, 'contextMenu'));
  messenger.messageDisplayAction.setTitle({ title: resent });
  messenger.messageDisplayAction.onClicked.addListener(redirect.getAddress.bind(redirect, 'messageDisplayAction'));
  messenger.browserAction.onClicked.addListener(redirect.getAddress.bind(redirect, 'browserAction'));
  messenger.commands.onCommand.addListener(redirect.getAddress.bind(redirect, 'keyboard'));

  screen = await messenger.smr.init(prefs);   //loads stylesheet etc.
  debug('screen=' + screen);
}
//messenger.menus.onShown.addListener(()=>{debug('menu shown');});

messenger.smr.onFilterUseCount.addListener((count) => {
  debug('onFilterUseCount fired: filterUseCount=' + count);
  messenger.storage.local.set({ filterUseCount: count });
});

/*
messenger.tabs.create({ url: "https://www.ggbs.de/extensions/SimpleMailRedirection.html" });
messenger.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  debug('onInstalled called, reason='+reason+' previousVersion='+previousVersion);
  if (reason == "update") {
    messenger.tabs.create({ url: "changes.html" });
  } else if (reason == "install") {
    messenger.tabs.create({ url: "install.html" });
  }
});
*/

let debugcache = '';
function debug(txt) {
  let e = new Error();
  let stack = e.stack.toString().split(/\r\n|\n/);
  let ln = stack[1].replace(/moz-extension:\/\/.*\/(.*:\d+):\d+/, '$1');	//getExternalFilename@file:///D:/sourcen/Mozilla/thunderbird/Extensions/AddressbooksSync_wee/abs_utils.js:1289:6
  if (!ln) ln = '?';

  if (prefs) {
    if (prefs.debug) {
      if (debugcache) console.log(debugcache); debugcache = '';
      console.log('SMR: ' + ln + ' ' + txt);
    }
  } else {
    debugcache += 'SMR: ' + ln + ' ' + txt + '\n';
  }
}


start();

