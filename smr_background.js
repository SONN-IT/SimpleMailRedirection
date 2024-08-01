//debug("background started");
let prefs = { debug: false };
var curTabId;
var curWinId;
var screen;

var redirect = {
  win: null,
  msgs: null,
  getAddress: async function (info, info2) {
    debug("got Addresses");
    //debug('info: '+JSON.stringify(info));
    //debug('info2: '+JSON.stringify(info2));
    if (typeof info == "string") {
      //keyboard shortcut pressed
      debug("keyboard shortcut pressed tabId=" + curTabId);
      //in mailTab:
      //	if nothing selected
      //		mh throws error
      //		mhs valid with no message
      //	if one message selected
      //		mh and mhs are valid
      //	im multiple messages are selected
      //		mh==null
      //		mhs is valid
      //in message tab
      //	mh is valid
      //	mhs throws error
      //in message window
      //	NO TABID
      let tabs = await messenger.tabs.query({
        active: true,
        currentWindow: true,
        //  lastFocusedWindow: true,
        //	windowId: curWinId
      }); //does not return the current window but the 3-pane window
      debug("queried for windowId=" + curWinId + " " + JSON.stringify(tabs));
      curTabId = (
        await messenger.tabs.query({
          active: true,
          //  currentWindow: true,
          //  lastFocusedWindow: true,
          windowId: curWinId,
        })
      )[0].id;
      debug("queried tabId=" + curTabId);
      try {
        this.msgs = (
          await messenger.mailTabs.getSelectedMessages(curTabId)
        ).messages;
        debug("mhs=" + JSON.stringify(this.msgs));
      } catch (e) {
        debug("not a mailTab");
        try {
          this.msgs = await messenger.messageDisplay.getDisplayedMessages(
            curTabId
          );
          debug("mhs=" + JSON.stringify(this.msgs));
        } catch (e) {
          debug("not a messageDisplay");
          return;
        }
      }
    } else {
      //if called from message list, we get 'selectedMessages' in info
      //if called from a message display, we get a 'pageUrl' in info, info2 is a tab
      //if called from action button, info is a tab
      //if called from browser action, info is a tab, info2 is OnClickData
      if (info.selectedMessages) {
        this.msgs = info.selectedMessages.messages;
      } else {
        let tabId = info.id ? info.id : info2.id;
        debug("tab=" + tabId);
        try {
          this.msgs = await messenger.messageDisplay.getDisplayedMessages(
            tabId
          );
          debug("mhs=" + JSON.stringify(this.msgs));
        } catch (e) {
          //throws 'msgHdr.getProperty is not a function' if TB started via .eml
          console.error("SMR: could not redirect if TB started via .eml file");
          debug("no msg, started via .eml?");
          this.msgs = [];
        }
      }
    }
    if (this.msgs.length > 0) {
      debug("num of messages=" + this.msgs.length);

      this.msgs.forEach(async (mh) => {
        //debug('mh='+JSON.stringify(mh));
        debug(
          "got message id=" + mh.id + " " + mh.subject + " (" + mh.author + ")"
        );
      });

      //id=1 folder={"accountId":"account1","name":"Posteingang","path":"/INBOX","type":"inbox"}
      messenger.runtime.onMessage.addListener(this.handleMessage);
      let pos = await messenger.storage.local.get([
        "top",
        "left",
        "height",
        "width",
        "size",
      ]);

      let minHeight = 300 + (this.msgs.length > 5 ? 150 : this.msgs.length * 30);
      let minWidth = 600;

      let height = pos.height ? Math.max(pos.height, minHeight) : minHeight;
      let width = pos.width ? Math.max(pos.width, minWidth) : minWidth;

      let win = await messenger.windows.create({
        height: height,
        width: width,
        allowScriptsToClose: true,
        url: "ui/RedirectWindow.html",
        type: "popup",
      });

      debug("screen=" + screen.width + "x" + screen.height);
      debug(
        "pos=" + pos.width + "x" + height + " at " + pos.left + "x" + pos.top
      );
      if (
        pos.top > 0 &&
        pos.top + height < screen.height &&
        pos.left > 0 &&
        pos.left + pos.width < screen.width
      ) {
        debug("positioned window to " + pos.left + "x" + pos.top);
        await messenger.windows.update(win.id, {
          top: pos.top,
          left: pos.left,
        });
      }
       
    } else {
      console.log("SMR: No message selected");
    }
    return;
  },

  handleMessage: function (request, sender, sendResponse) {
    //debug('request='+JSON.stringify(request)+' sender='+sender);
    if (request && request.action)
      switch (request.action) {
        case "requestData": // send info about selected messages to popup
          prefs = request.prefs;
          debug(
            "requestData, send messages, prefs now " + JSON.stringify(prefs)
          );
          sendResponse(redirect.msgs);
          break;
      }
    return true;
  },
};

async function start() {
  debug("background started");
  prefs = await messenger.storage.local.get({ debug: false });
  //dont use storage.local.get() (without arg), see https://thunderbird.topicbox.com/groups/addons/T46e96308f41c0de1
  let resent = messenger.i18n.getMessage("resent");
  // shown in context menu of message list
  messenger.menus.create({
    contexts: ["message_list"],
    id: "smr_redirect_mail",
    onclick: redirect.getAddress.bind(redirect),
    title: resent,
    //    ,icons: {16: "skin/SimpleMailRedirection.svg"}  //not working on main menu item :-(
  });
  // shown in context menu of all messages, but need to get current message as no messages selected
  // returns a "pageUrl":"imap://mail.davbs.de:993/fetch%3EUID%3E.INBOX%3E10617"
  messenger.menus.create({
    contexts: ["page"], //no: frame, tab, selection, browser_action
    //documentUrlPatterns: ["*://*/*"],	//["imap-message://*/*"],
    //viewTypes: ['popup'],
    id: "smr_redirect_msg",
    onclick: redirect.getAddress.bind(redirect),
    title: resent,
    //    ,icons: {16: "skin/SimpleMailRedirection.svg"}  //not working on main menu item :-(
  });
  messenger.messageDisplayAction.setTitle({ title: resent });
  messenger.messageDisplayAction.onClicked.addListener(
    redirect.getAddress.bind(redirect)
  );

  messenger.commands.onCommand.addListener(redirect.getAddress.bind(redirect));
  messenger.tabs.onActivated.addListener((info) => {
    curTabId = info.tabId;
    curWinId = info.windowId;
    debug("tab activated tab=" + curTabId + " window=" + curWinId);
  });
  messenger.tabs.onCreated.addListener((tab) => {
    if (tab.active) {
      curTabId = tab.id;
      curWinId = tab.windowId;
    }
    debug(
      "tab created tab=" +
        curTabId +
        " window=" +
        curWinId +
        " status=" +
        tab.status +
        " active=" +
        tab.active +
        " index=" +
        tab.index
    );
  });
  messenger.windows.onFocusChanged.addListener((windowId) => {
    curWinId = windowId;
    curTabId = null;
    //debug('window focus window='+curWinId);
  });

  messenger.browserAction.onClicked.addListener(
    redirect.getAddress.bind(redirect)
  );

  screen = await messenger.smr.init(prefs); //loads stylesheet etc.
  debug("screen=" + screen);
}
//messenger.menus.onShown.addListener(()=>{debug('menu shown');});

messenger.smr.onFilterUseCount.addListener((count) => {
  debug("onFilterUseCount fired: filterUseCount=" + count);
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

let debugcache = "";
function debug(txt) {
  let e = new Error();
  let stack = e.stack.toString().split(/\r\n|\n/);
  let ln = stack[1].replace(/moz-extension:\/\/.*\/(.*:\d+):\d+/, "$1"); //getExternalFilename@file:///D:/sourcen/Mozilla/thunderbird/Extensions/AddressbooksSync_wee/abs_utils.js:1289:6
  if (!ln) ln = "?";

  if (prefs) {
    if (prefs.debug) {
      if (debugcache) console.log(debugcache);
      debugcache = "";
      console.log("SMR: " + ln + " " + txt);
    }
  } else {
    debugcache += "SMR: " + ln + " " + txt + "\n";
  }
}

start();
