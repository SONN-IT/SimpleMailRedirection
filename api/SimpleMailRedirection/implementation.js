const { ExtensionCommon } = ChromeUtils.import(
  "resource://gre/modules/ExtensionCommon.jsm"
);
const { ExtensionSupport } = ChromeUtils.import(
  "resource:///modules/ExtensionSupport.jsm"
);

var Services =
  globalThis.Services ||
  ChromeUtils.import("resource://gre/modules/Services.jsm").Services;
const { AddonManager } = ChromeUtils.import(
  "resource://gre/modules/AddonManager.jsm"
);

const { MailServices } = ChromeUtils.import(
  "resource:///modules/MailServices.jsm"
);
const { MailUtils } = ChromeUtils.import("resource:///modules/MailUtils.jsm");
const { FileUtils } = ChromeUtils.import(
  "resource://gre/modules/FileUtils.jsm"
);
var MsgUtils;
try {
  MsgUtils = ChromeUtils.import(
    "resource:///modules/MimeMessageUtils.jsm"
  ).MsgUtils;
  var { jsmime } = ChromeUtils.import("resource:///modules/jsmime.jsm");
} catch (e) {
  MsgUtils = null; /* TB78 */
}

const EXTENSION_ID = "simplemailredirection@ggbs.de";
var extension;

const MAX_HEADER_LENGTH = 16384;

var prefs;
var initcalled = false;
var windows = new Object();
var appVersion;
var gContext = null;
var gFilterUseCount;
var gFireFilterUseCount;

//debug('entered');
var smr = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    //pref.debug not set yet!
    debug("onStartup");
  }

  onShutdown(isAppShutdown) {
    debug("onShutdown isAppShutdown=" + isAppShutdown);
    if (isAppShutdown) return;
    // Looks like we got uninstalled. Maybe a new version will be installed
    // now. Due to new versions not taking effect
    // (https://bugzilla.mozilla.org/show_bug.cgi?id=1634348)
    // we invalidate the startup cache. That's the same effect as starting
    // with -purgecaches (or deleting the startupCache directory from the
    // profile).
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }
  getAPI(context) {
    debug("getApi entered"); //more than once! (on App start and when redirect window opens
    if (!gContext) {
      debug("initial start, load filter");
      gContext = context;
      extension = context.extension;
      context.callOnClose(this);
      Services.scriptloader.loadSubScript(
        context.extension.rootURI.resolve("./smr_filter.js")
      );
      gFilterUseCount = redirectFilterWrapper.onStartup(); //filterStart();
      debug("filterUseCount=" + gFilterUseCount);
      if (gFireFilterUseCount) {
        debug("fire gFilterUseCount=" + gFilterUseCount);
        gFireFilterUseCount.async(gFilterUseCount); //else fire on register
      }
      this.getAddon();
    }

    return {
      smr: {
        init: async function (options) {
          prefs = options;
          debug("init debug=" + prefs.debug);
          if (initcalled) return; //only change in prefs
          let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
          debug("  stylesheet timer=" + timer + " context=" + context);
          timer.initWithCallback(
            () => {
              stylesheets(context, true);
            },
            1000,
            Ci.nsITimer.TYPE_ONE_SHOT
          );
          let m3p = Services.wm.getMostRecentWindow("mail:3pane");
          debug("screen=" + m3p.screen.width + "x" + m3p.screen.height);
          initcalled = true;
          return { width: m3p.screen.width, height: m3p.screen.height };
        },
        redirect: async function (mhs, rts, params, windowId, options) {
          prefs = options;
          debug("redirect from window windowId=" + windowId);
          //debug('prefs='+JSON.stringify(prefs));
          //mhs.forEach(mh=>debug('redirect '+(!mh.sending?'but skipped ':'')+mh.subject+' ('+mh.author+')'));
          //rts.forEach(addr=>debug('resentTo '+addr.to+' '+addr.email));

          // cleanup from vanished windows
          for (let wid in windows) {
            //debug('cache check windowId '+wid);
            if (!windows[wid].fire) {
              //debug('cache delete windowId '+wid);
              delete windows[wid];
            }
          }

          windows[windowId].msgCount = mhs.length;
          mhs.forEach((mh) => {
            if (mh.sending) {
              // skip already successfull send messages
              mh.state = "waiting";
              windows[windowId][mh.id] = mh;
              windows[windowId][mh.id].msgHdr =
                context.extension.messageManager.get(mh.id);
              if (windows[windowId].fire) {
                debug("waiting: notify popup window");
                windows[windowId].fire.async({ msgid: mh.id, type: "waiting" });
              } else {
                debug("waiting: popup window has vanished");
              }
            }
          });
          windows[windowId].allowResend = false;
          windows[windowId].params = params;
          //TEST:
          //mhs.forEach(mh=>windows[windowId][mh.id]['msgSend']='send_'+mh.id);
          let resent = new Object();
          rts.forEach((addr) => {
            //.to is 'TO', 'CC' or 'BCC'
            resent[addr.to] = resent[addr.to] ? resent[addr.to] + "," : "";
            resent[addr.to] += addr.email;
          });
          debug("resent=" + JSON.stringify(resent));
          windows[windowId].resent = resent;
          let accountId = (windows[windowId].accountId = params.accountId); //mh.folder.accountId;
          let identity = (windows[windowId].identity =
            MailServices.accounts.getIdentity(params.identityId));
          let maxConn = 4;
          debug("using maxConn=" + maxConn);
          mhs.every((mh) => {
            if (mh.sending) {
              mh.state = "started";
              prepareMessage(
                windows[windowId][mh.id].msgHdr,
                accountId,
                identity,
                params,
                resent,
                windowId,
                mh.id
              );
              if (maxConn && --maxConn == 0) return false; //break out of loop
            }
            return true; //continue
          });
        },
        abort: async function (windowId, msgId) {
          debug("abort windowId=" + windowId + " msgId=" + msgId);
          let msg = windows[windowId][msgId];
          if (msg.msgSend) {
            debug("already sending, abort");
            msg.msgSend.abort();
          }
          msg.state = "abort"; //mark for abort after filecopy
        },

        ///////////
        onMailSent: new ExtensionCommon.EventManager({
          context,
          name: "smr.onMailSent",
          register(fire, windowIdparam) {
            debug("onMailSent register windowId=" + windowIdparam);
            let windowId = windowIdparam;
            windows[windowId] = new Object();
            windows[windowId].fire = fire;
            return function () {
              debug("onMailSent unregister windowId=" + windowId);
              if (!windows[windowId]) return;
              windows[windowId].fire = null;
              for (const [msgId, msg] of Object.entries(windows[windowId])) {
                if (isNaN(msgId)) continue; //.fire or other
                debug("  abort " + msgId + " " + msg.subject);
                if (msg.state == "started") {
                  if (msg.msgSend) {
                    debug("    already sending, abort");
                    msg.msgSend.abort();
                  }
                  msg.state = "abort"; //mark for abort after filecopy
                }
              }
            };
          },
        }).api(),
        onFilterUseCount: new ExtensionCommon.EventManager({
          context,
          name: "smr.onFilterUseCount",
          register(fire) {
            debug("onFilterUseCount register");
            gFireFilterUseCount = fire;
            //use gFireFilterUseCount.async(filterUseCount);
            if (gFilterUseCount !== undefined) {
              debug("fire gFilterUseCount=" + gFilterUseCount);
              gFireFilterUseCount.async(gFilterUseCount);
            }
            return function () {
              debug("onFilterUseCount unregister");
              gFireFilterUseCount = null;
            };
          },
        }).api(),
      },
    };
  }
  close() {
    // This function is called if the extension is disabled or removed, or Thunderbird closes.
    // Also called if our html window closes
    debug("close");
    redirectFilterWrapper.onShutdown(); //filterStop();
    stylesheets(gContext, false);
  }
  async getAddon() {
    let addOn = await AddonManager.getAddonByID(EXTENSION_ID);
    let console = Services.console;
    let app = Services.appinfo;
    console.logStringMessage(
      "SimpleMailRedirection: " +
      addOn.version +
      " on " +
      app.name +
      " " +
      app.version
    );
    appVersion = app.version.replace(/^(\d+\.\d+)(\..*)?$/, "$1");
  }
};

////////////////////////////////////////////////////////////////
async function prepareMessage(
  msgHdr,
  accountId,
  identity,
  params,
  resent,
  windowId,
  msgId
) {
  debug("got msgHdr id=" + msgHdr.messageKey);
  if (windowId) {
    if (windows[windowId].fire) {
      debug("converting: notify popup window");
      windows[windowId].fire.async({ msgid: msgId, type: "converting" });
    } else {
      debug("converting: popup window has vanished");
    }
  } else {
    debug("converting: called from filter");
  }

  //if we are called from a filter which also moves the message to another
  //folder, setting the 'redirected' flags/keywords after redirecting took place
  //comes too late, so we set them here (must remove them in case of error)
  markAsRedirected(msgHdr, true);

  let msgUri = msgHdr.folder.generateMessageURI(msgHdr.messageKey);
  let sender = MailServices.headerParser.makeMimeHeader(
    [{ name: identity.fullName, email: identity.email }],
    1
  );
  debug("call resent URI=" + msgUri + " sender=" + sender);
  let msgCompFields = Cc[
    "@mozilla.org/messengercompose/composefields;1"
  ].createInstance(Ci.nsIMsgCompFields);
  if (resent["TO"]) msgCompFields.to = resent["TO"]; //this converts to quoted printable!
  if (resent["CC"]) msgCompFields.cc = resent["CC"]; //this converts to quoted printable!
  if (resent["BCC"]) msgCompFields.bcc = resent["BCC"]; //this converts to quoted printable!
  msgCompFields.from = sender;
  if (params.copy2sent) {
    msgCompFields.fcc = identity.fccFolder;
    debug("copy msg to " + identity.fccFolder);
  } else {
    msgCompFields.fcc = "nocopy://";
  }
  msgCompFields.fcc2 = ""; //was "nocopy://", but TB91 needs ""
  let messageId;
  try {
    //<=TB102 (with 1 arg), TB>=115.5 (with 2 args)
    messageId = Cc["@mozilla.org/messengercompose/computils;1"]
      .createInstance(Ci.nsIMsgCompUtils)
      .msgGenerateMessageId(identity, null); //2. arg is host, e.g. fromAddr.slice(atIndex + 1)
  } catch (e) {
    //>=TB115 <TB115.5
    messageId = Cc["@mozilla.org/messengercompose/computils;1"]
      .createInstance(Ci.nsIMsgCompUtils)
      .msgGenerateMessageIdFromIdentity(identity);
  }
  msgCompFields.messageId = messageId;
  resentMessage(msgId, windowId, msgUri, accountId, msgCompFields, identity);
}

////////////////////////////////////////////

function nsMsgSendListener(msgId, windowId, msgUri, tmpFile) {
  this.msgId = msgId;
  this.windowId = windowId;
  this.msgUri = msgUri;
  this.tmpFile = tmpFile;
  this.size = tmpFile.fileSize;
}
nsMsgSendListener.prototype = {
  msgId: null,
  windowId: null,
  msgUri: null,
  tmpFile: null,
  size: 0,

  QueryInterface: function (iid) {
    if (
      iid.equals(Ci.nsIMsgSendListener) ||
      iid.equals(Ci.nsIMsgCopyServiceListener) ||
      iid.equals(Ci.nsISupports)
    ) {
      return this;
    }
    throw Components.results.NS_NOINTERFACE;
  },
  onProgress(msgId, progress, progressMax) {
    //not called :-(
    debug("onProgress " + progress + " up to  " + progressMax);
  },
  onStartSending(msgId, msgSize) {
    //msgId is null
    //msgSize is always 0 :-(
    if (!this.windowId) return; //filter
    if (windows[this.windowId].fire) {
      debug("nsMsgSendListener.onStartSending: notify popup window");
      debug(
        "nsMsgSendListener.onStartSending: windowId=" +
        this.windowId +
        " " +
        windows[this.windowId]
      );
      windows[this.windowId].fire.async({
        msgid: this.msgId,
        type: "started",
        size: this.size,
      });
    } else {
      debug("started: popup window has vanished");
    }
  },
  onStopSending(aMsgID, aStatus, aMsg, returnFileSpec) {
    debug(
      "nsMsgSendListener.onStopSending " +
      aMsgID +
      ", " +
      aStatus +
      ", " +
      aMsg +
      ", " +
      returnFileSpec +
      " " +
      this.msgUri
    );
    debug(
      "nsMsgSendListener.onStopSending windowId=" +
      this.windowId +
      " " +
      windows[this.windowId]
    );

    // ovh.net sends a "421 Service not available, closing transmission channel"
    // message which leads to an error popup and a second call of onStopSending()
    // see mails from Sep. 23 (Tony - Debret Escaliers <debret.communication@gmail.com>)
    if (this.windowId && !windows[this.windowId]) return;

    let allowResend = "";
    //with old MsgSend (TB78) we might have success even if message has been aborted
    if (this.windowId) {
      //!filter
      debug("  state=" + windows[this.windowId][this.msgId].state);
      if (
        !MsgUtils &&
        !aStatus &&
        windows[this.windowId][this.msgId].state == "abort"
      ) {
        aStatus = 0x805530ef;
        debug("   success but abort: set to failed");
      }
    }
    if (aStatus) {
      //aMsgID is empty on error
      //TB91:
      //aStatus=2153066725 (0x805530e5, NS_ERROR_SENDING_MESSAGE) if web.de problem
      //aStatus=2153066783 (0x8055311F, NS_ERROR_SENDING_RCPT_COMMAND) if status=550, recipient unknown
      //aStatus=2153066732 (0x805530EC, NS_ERROR_SMTP_SERVER_ERROR) all kind of errors
      //    status=421, temporary failure (too many connections (concurrent or in a specified time interval))
      //aStatus is one of MsgUtils.NS_ERROR_SMTP_... errors, defined in modules/MimeMessageUtils.jsm in TB91
      if (MsgUtils != null)
        debug(
          "MsgSend returned bad status: " + MsgUtils.getErrorStringName(aStatus)
        );
      //      if (aStatus==MsgUtils.NS_ERROR_SENDING_RCPT_COMMAND) allowResend='badRCPT';
      //      else if (aStatus==MsgUtils.NS_ERROR_SENDING_MESSAGE) allowResend='badSend'; //i.e. web.de
      //TB78:
      //aStatus=2153066735 (0x805530ef, NS_ERROR_BUT_DONT_SHOW_ALERT) for every error
      //    defined in comm\mailnews\compose\src\nsComposeStrings.h in TB78
      allowResend = "sendError";
      try {
        this.tmpFile.remove(false);
      } catch (e) {
        /* already removed */
      }
      markAsRedirected(this.msgUri, false); //remove 'redirected' flags/keywords
    } else {
      // mark message as 'redirected' (this is now done before sending)
      //markAsRedirected(this.msgUri, true);
    }

    if (!this.windowId) return; //filter

    if (windows[this.windowId].fire) {
      debug("finished: notify popup window");
      windows[this.windowId].fire.async({
        msgid: this.msgId,
        type: "finished",
        state: aStatus,
        allowResend: allowResend,
      });
      if (allowResend) windows[this.windowId].allowResend = true;
    } else {
      debug("finished: popup window has vanished");
    }
    windows[this.windowId][this.msgId].state = "finished";
    windows[this.windowId].msgCount--;
    /*
for (const [windowId, data] of Object.entries(windows)) {
  for (const [msgId, mh] of Object.entries(data)) {
    if (isNaN(msgId)) debug(`cache ${windowId} ${msgId} ${mh}`);
    else debug(`cache msgId ${windowId} ${msgId} ${mh.id} ${mh.state} ${mh.subject}`);
  }
}
*/
    // start next message if there is one waiting
    let windowId = this.windowId;
    for (const [msgId, msg] of Object.entries(windows[windowId])) {
      if (isNaN(msgId)) continue; //.fire or other
      if (!msg.sending || msg.state != "waiting") continue;
      debug("maxConn: next message: " + msgId + " " + msg.subject);
      let msgHdr = gContext.extension.messageManager.get(msgId);
      msg.state = "started";
      prepareMessage(
        msg.msgHdr,
        windows[windowId].accountId,
        windows[windowId].identity,
        windows[windowId].params,
        windows[windowId].resent,
        windowId,
        msgId
      );
      break;
    }

    if (
      !windows[this.windowId].msgCount &&
      !windows[this.windowId].allowResend
    ) {
      debug("delete windowId " + this.windowId);
      delete windows[this.windowId];
    }
  },
  onGetDraftFolderURI(uri) {
    //needed since TB88
    debug("onGetDraftFolderURI: uri=" + uri.spec);
  },
  onStatus(aMsgID, aMsg) {
    //no
    debug("nsMsgSendListener.onStatus: msgId=" + aMsgID + " msg=" + aMsg);
  },
  onSendNotPerformed(aMsgID, aStatus) {
    //no
    debug(
      "nsMsgSendListener.onSendNotPerformed: msgId=" +
      aMsgID +
      " status=" +
      aStatus
    );
  },
  onTransportSecurityError(msgID, status, secInfo, location) {
    //no
    debug("nsMsgSendListener.onTransportSecurityError");
  },
};

////////////////////////////////////////////

function resentMessage(
  msgId,
  windowId,
  uri,
  accountId,
  msgCompFields,
  identity
) {
  debug("resentMessage " + uri);

  let tmpFile;
  if (FileUtils.getFile) {
    //up to TB115
    debug("use FileUtils.getFile (up to TB115)");
    tmpFile = FileUtils.getFile("TmpD", ["tb_simplemailredirection.tmp"]);
  } else {
    //since TB116
    debug("use FileUtils.File(PathUtils... (since TB116)");
    let m3p = Services.wm.getMostRecentWindow("mail:3pane");
    tmpFile = new FileUtils.File(
      m3p.PathUtils.join(m3p.PathUtils.tempDir, "tb_simplemailredirection.tmp")
    );
  }
  tmpFile.createUnique(tmpFile.NORMAL_FILE_TYPE, parseInt("0600", 8));
  if (tmpFile === null) {
    debug("temp localfile is null");
    return;
  } else {
    debug("writing message to " + tmpFile.path);
  }

  let changeFrom =
    prefs.changefrom && prefs.changefrom[accountId + "|" + identity.key]
      ? prefs.changefrom[accountId + "|" + identity.key]
      : false; //workaround web.de
  debug(
    "workaround changeFrom for " +
    accountId +
    "|" +
    identity.key +
    " is " +
    changeFrom
  );

  let aScriptableInputStream = Cc[
    "@mozilla.org/scriptableinputstream;1"
  ].createInstance(Ci.nsIScriptableInputStream);
  let aFileOutputStream = Cc[
    "@mozilla.org/network/file-output-stream;1"
  ].createInstance(Ci.nsIFileOutputStream);

  let inHeader = true;
  let skipping = false;
  let leftovers = "";
  let buf = "";
  let line = "";
  let replyTo = "";
  let haveReplyTo = false;
  let lt = ""; //line terminator, determined on first call
  let lts; //size of line terminator

  let aCopyListener = {
    onStartRequest: function (aRequest, aContext) { },

    onStopRequest: function (aRequest, aContext, aStatusCode) {
      // write leftovers
      aFileOutputStream.write(leftovers, leftovers.length);
      aFileOutputStream.close();

      if (aStatusCode) {
        debug(
          "aCopyListener.onStopRequest failed " +
          aRequest +
          ", " +
          aContext +
          ", " +
          aStatusCode
        );
        return;
      }
      let test =
        msgCompFields.to.toLowerCase().includes("testggbs@ggbs.de") ||
        msgCompFields.to.toLowerCase().includes("ggbstest@ggbs.de") ||
        msgCompFields.to.toLowerCase().includes("test@ggbs.de") ||
        msgCompFields.to.toLowerCase().includes("ggbs@ggbs.de");
      if (windowId /*!filter*/ && windows[windowId][msgId].state == "abort") {
        debug("abort: remove tmpfile");
        tmpFile.remove(false);
        if (windows[windowId].fire) {
          windows[windowId].fire.async({
            msgid: msgId,
            type: "aborted",
            state: 1,
          });
        } else {
          debug("copied: popup window has vanished");
        }
        windows[windowId].msgCount--;
        if (!windows[windowId].msgCount) {
          debug("delete windowId " + windowId);
          delete windows[windowId];
        }
        return;
      }
      //TEST
      debug("file copied to tempfile " + tmpFile.path);
      if (windowId /*!filter*/ && test) {
        console.log("SMR: TEST mode, no msgSend"); //log even if no debug
        for (const [windowId, data] of Object.entries(windows)) {
          for (const [msgId, mh] of Object.entries(data)) {
            if (isNaN(msgId)) debug(`cache ${windowId} ${msgId} ${mh}`);
            else
              debug(
                `cache msgId ${windowId} ${msgId} ${mh.id} ${mh.msgSend} ${mh.subject}`
              );
          }
        }
        windows[windowId][msgId].state = "finished";
        let m3p = Services.wm.getMostRecentWindow("mail:3pane");
        m3p.setTimeout(() => {
          if (windows[windowId].fire)
            windows[windowId].fire.async({
              msgid: msgId,
              type: "finished",
              status: 1,
            });
          windows[windowId].msgCount--;
          if (!windows[windowId].msgCount) {
            debug("delete windowId " + windowId);
            delete windows[windowId];
          }
        }, 3000);
        return;
      }
      //TEST End

      //TODO: fixit!
      if (tmpFile.fileSize == 0) {
        console.error("SimpleMailRedirection: message has vanished while redirecting, probably you've used filter action 'Move message ...' or 'Delete message'");
        tmpFile.remove(false);
        return;
      }

      debug(
        "account=" +
        accountId +
        " identity=" +
        identity.fullName +
        " <" +
        identity.email +
        "> => sender=" +
        msgCompFields.from
      );

      // send a message
      let msgSendListener = new nsMsgSendListener(
        msgId,
        windowId,
        uri,
        tmpFile
      );
      let msgSend = Cc["@mozilla.org/messengercompose/send;1"].createInstance(
        Ci.nsIMsgSend
      );
      if (windowId /*!filter*/) windows[windowId][msgId].msgSend = msgSend;

      //mode: nsMsgDeliverNow, nsMsgQueueForLater, nsMsgDeliverBackground
      //msgSend.nsMsgDeliverBackground, msgSend.nsMsgQueueForLater:
      // Both put the message in the outbox of local folders
      // DeliverBackground should deliver automatically after some seconds
      // QueueForLater waits for the user to select 'send messages from outbox now'
      // Both does not work. Mail has the resent-headers, but they are not respected by TB

      debug("compFields: " + JSON.stringify(msgCompFields));
      //      try {
      msgSend.sendMessageFile(
        identity, // in nsIMsgIdentity       aUserIdentity,
        accountId, // char* accountKey,
        msgCompFields, // in nsIMsgCompFields     fields,
        tmpFile, // in nsIFile              sendIFile,
        /*true*/!prefs.debug,            // in PRBool               deleteSendFileOnCompletion,
        false, // in PRBool               digest_p,
        msgSend.nsMsgDeliverNow, // in nsMsgDeliverMode     mode,
        null, // in nsIMsgDBHdr          msgToReplace,
        msgSendListener, // in nsIMsgSendListener   aListener,
        null, // in nsIMsgStatusFeedback aStatusFeedback,
        "" // in string               password
      );
      //      } catch(e) {
      //        console.log('SMR: exception when sending message:' + e);
      //      }
    }, //end of onStopRequest

    onDataAvailable: function (aRequest, aInputStream, aOffset, aCount) {
      debug("onDataAvailable");
      if (windowId /*!filter*/ && windows[windowId][msgId].state == "abort") {
        debug("onDataAvailable aborted");
        //        throw 'aborted';
        //see https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIStreamListener
        //but does not work
        return;
      }

      aScriptableInputStream.init(aInputStream);
      //dumper.dump("!! inHeader reading new buffer, " + aCount + " bytes");
      buf = leftovers + aScriptableInputStream.read(aCount);
      if (!lt) {
        if (buf.indexOf("\r") === -1) {
          //probably linefeed only?
          lt = "\n";
          lts = 1;
          debug("Lineending LF (Linux/MacOS)");
        } else {
          lt = "\r\n";
          lts = 2;
          debug("Lineending CR/LF (Windows)");
        }
        // write out Resent-* headers
        let resenthdrs = getResentHeaders(msgCompFields, identity);
        debug(
          "resent with account=" +
          accountId +
          " identity=" +
          identity.fullName +
          " <" +
          identity.email +
          "> => sender=" +
          msgCompFields.from
        );
        aFileOutputStream.write(resenthdrs, resenthdrs.length);
      }
      if (inHeader) {
        leftovers = "";

        while (buf.length > 0) {
          // find end of line
          let eol = buf.indexOf("\r"); //can't check for lt, since \r and \n might be splitted
          if (eol === -1) {
            //probably linefeed only?
            eol = buf.indexOf("\n");
          }

          if (eol === -1) {
            // no end of line character in buffer
            // remember this part for the next time
            leftovers = buf;
            // dumper.dump("leftovers=>>"+leftovers+"<<leftovers_end. length=" + leftovers.length);
            break;
          } else {
            // try a pair of eol chars
            if (lts == 2) {
              if (eol + 1 < buf.length) {
                eol++; // forward to \n
              } else {
                // pair couldn't be found because of end of buffer
                // dumper.dump("pair couldn't be found. end of buf. eol="+eol+" buf.length="+buf.length);
                leftovers = buf;
                break;
              }
            }
            line = buf.substr(0, eol + 1 - lts);
            buf = buf.substr(eol + 1);
            // dumper.dump("line=>>"+line+"<<line_end. length=" + line.length);

            //            if (line == lt || line == "\r\n") {	//empty line
            if (line == "") {
              //empty line
              if (changeFrom && !haveReplyTo) {
                debug("workaround changeFrom: add " + replyTo);
                let ret = aFileOutputStream.write(
                  replyTo + "\r\n",
                  replyTo.length + 2
                );
                if (ret !== replyTo.length + 2) {
                  debug(
                    "!! inHeader write error? line len " +
                    replyTo.length +
                    ", written " +
                    ret
                  );
                }
              }
              aFileOutputStream.write(line + "\r\n", line.length + 2);
              inHeader = false;
              //debug("End of headers");
              leftovers = buf;
              break;
            }
          }

          if (skipping) {
            if (line[0] === " " || line[0] === "\t") {
              // dumper.dump("forbidden line:" + line+"<<");
              // continue;
            } else {
              skipping = false;
            }
          }

          /*workaround web.de*/
          if (changeFrom) {
            if (/^from: /i.test(line)) {
              debug("workaround changeFrom: have " + line);
              //if domain of From: address == domain of msgCompFields.from address  => don't change!
              let headerParser = MailServices.headerParser;
              let mf = headerParser
                .extractHeaderAddressMailboxes(line)
                .split("@")[1];
              let rf = headerParser
                .extractHeaderAddressMailboxes(msgCompFields.from)
                .split("@")[1];
              debug("parsed From: " + mf + " vs " + rf);
              if (mf == rf) {
                changeFrom = false; //no need to rewrite from: same mail domain
                debug(" => no need to rewrite from");
              } else {
                replyTo = line.replace(/^[Ff]rom:/, "Reply-To:"); //save for later use
                line = "From: " + msgCompFields.from;
                debug("workaround changeFrom: rewrite to " + line);
              }
            } else if (/^reply-to: /i.test(line)) {
              haveReplyTo = true;
              debug("workaround changeFrom: already have a Reply-To: " + line);
            }
          }
          // remove sensitive headers (vide: nsMsgSendPart.cpp)
          // From_ line format - http://www.qmail.org/man/man5/mbox.html
          if (
            /^[>]*From \S+ /.test(line) ||
            /^bcc: /i.test(line) ||
            /^resent-bcc: /i.test(line) ||
            /^fcc: /i.test(line) ||
            /^content-length: /i.test(line) ||
            /^lines: /i.test(line) ||
            /^status: /i.test(line) ||
            /^x-mozilla-status(?:2)?: /i.test(line) ||
            /^x-mozilla-draft-info: /i.test(line) ||
            /^x-mozilla-newshost: /i.test(line) ||
            /^x-uidl: /i.test(line) ||
            /^x-vm-\S+: /i.test(line) ||
            /^return-path: /i.test(line) ||
            /^delivered-to: /i.test(line) ||
            /^dkim-signature: /i.test(line) || //added, at least necessary if rewritimg the 'From:' header
            // for drafts
            /^FCC: /i.test(line) ||
            /^x-identity-key: /i.test(line) ||
            /^x-account-key: /i.test(line)
          ) {
            skipping = true; // discard line
            debug("removed line: " + line);
          }

          if (!skipping) {
            let ret = aFileOutputStream.write(line + "\r\n", line.length + 2);
            if (ret !== line.length + 2) {
              debug(
                "!! inHeader write error? line len " +
                line.length +
                ", written " +
                ret
              );
            }
          }
        }

        if (!inHeader && leftovers !== "") {
          // convert all possible line terminations to CRLF (required by RFC822)
          leftovers = leftovers.replace(/\r\n|\n\r|\r|\n/g, "\r\n");
          ret = aFileOutputStream.write(leftovers, leftovers.length);
          if (ret !== leftovers.length) {
            debug(
              "!! inBody write error? leftovers len " +
              leftovers.length +
              ", written " +
              ret
            );
          }
          leftovers = "";
        }
      } else {
        // out of header -- read the rest and write to file
        leftovers = "";
        // convert all possible line terminations to CRLF (required by RFC822)
        buf = buf.replace(/\r\n|\n\r|\r|\n/g, "\r\n");
        ret = aFileOutputStream.write(buf, buf.length);
        if (ret !== buf.length) {
          debug(
            "!! inBody write error? buf len " + buf.length + ", written " + ret
          );
        }
        buf = "";
      }
    }, //End of onDataAvailable
  }; // End of aCopyListener

  var msgService;
  if (MailServices.messageServiceFromURI) {
    //since TB111
    msgService = MailServices.messageServiceFromURI(uri);
  } else {
    let messenger = Cc["@mozilla.org/messenger;1"].createInstance(
      Ci.nsIMessenger
    );
    msgService = messenger.messageServiceFromURI(uri);
  }

  try {
    aFileOutputStream.init(tmpFile, -1, parseInt("0600", 8), 0);
  } catch (e) {
    debug("aFileOutputStream.init() failed:" + e);
    return;
  }

  //let msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(Ci.nsIMsgWindow);
  try {
    // up to TB113
    let newURI = {};
    msgService.CopyMessage(
      uri,
      aCopyListener,
      false,
      null,
      null /*msgWindow*/,
      newURI
    );
    debug("copied to newURI = " + newURI.value.spec);
    //newURI = null;
  } catch (e) {
    // since TB114
    msgService.copyMessage(uri, aCopyListener, false, null, null /*msgWindow*/);
  }
}

function markAsRedirected(hdrOrUri, onOff) {
  let msgHdr;
  if (typeof hdrOrUri == "string") {
    let msgUri = hdrOrUri;
    let msgService;
    if (MailServices.messageServiceFromURI) {
      //since TB111
      msgService = MailServices.messageServiceFromURI(msgUri);
    } else {
      let messenger = Cc["@mozilla.org/messenger;1"].createInstance(
        Ci.nsIMessenger
      );
      msgService = messenger.messageServiceFromURI(msgUri);
    }
    msgHdr = msgService.messageURIToMsgHdr(msgUri);
  } else {
    msgHdr = hdrOrUri;
  }
  let msg;
  if (appVersion < 85) {
    msg = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
    msg.appendElement(msgHdr, false);
  } else {
    msg = new Array();
    msg.push(msgHdr);
  }

  //debug('current keywords: '+msgHdr.getStringProperty("keywords"));
  if (/(?:^| )redirected(?: |$)/.test(msgHdr.getStringProperty("keywords"))) {
    debug("..already resent!");
    /*
debug('Test: remove redirected indicator from old version');
//up to TB84
let msg = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
msg.appendElement(msgHdr, false);
//since TB85
let msg=[msgHdr];
msgHdr.folder.removeKeywordsFromMessages(msg, "resent");
msgHdr.folder.addKeywordsToMessages(msg, "redirected");
*/
  }

  try {
    //        msgHdr.folder.addKeywordsToMessages(msg, "redirected Umgeleitet");
    if (onOff) msgHdr.folder.addKeywordsToMessages(msg, "redirected");
    //This sets a tag (Schlagwort) ('e.g. 'myredirect') on the mail
    //and also sets a property ('Tmyredirect') to the <tr> of the message
    else msgHdr.folder.removeKeywordsFromMessages(msg, "redirected");
  } catch (e) {
    debug("addKeywords throws: " + e);
  }
  debug(
    (onOff ? "added" : "removed") +
    " keyword, now set to: " +
    msgHdr.getStringProperty("keywords")
  );

  //set 'redirected' flag to message (available since TB91)
  //this sets the 'redirect' property on the <tr> of the message
  //This flag is removed from the message, if the message is moved to another folder
  try {
    //Ci.nsMsgMessageFlags.Redirected== 0x00002000;, see mailnews/base/public/nsMsgMessageFlags.idl
    //debug('old message flags: '+msgHdr.flags+' (redirected=0x2000)');
    let msgDB = msgHdr.folder.msgDatabase;
    let msgKey = msgHdr.messageKey;
    if (msgDB.markRedirected)
      msgDB.markRedirected(msgKey, onOff, null); // since TB108(?)
    else msgDB.MarkRedirected(msgKey, onOff, null); // up to TB107(?)
    debug(
      (onOff ? "added" : "removed") +
      " redirected flag, flags now 0x" +
      msgHdr.flags.toString(16) +
      " (redirected=0x2000)"
    );
  } catch (e) {
    debug("add redirected flag throws: " + e);
  }
}

function getResentHeaders(msgCompFields, identity) {
  let resenthdrs = "";

  // add default custom headers (from mail.identity.(default|idn).headers)
  //TB78: nsMsgComposeAndSend::AddDefaultCustomHeaders() in comm/mailnews/compose/src/nsMsgSend.cpp
  if (MsgUtils) {
    //since TB91
    //see modules/MimeMessage.jsm#219
    let headers = new Map();
    for (let { headerName, headerValue } of MsgUtils.getDefaultCustomHeaders(
      identity
    )) {
      debug('custom header "' + headerName + ": " + headerValue + '"');
      headers.set(headerName, [headerValue]);
    }
    if (headers.size) {
      // see modules/MimePart.jsm#195
      let h = jsmime.headeremitter.emitStructuredHeaders(headers, {
        useASCII: true,
        sanitizeDate: false,
      });
      debug('custom headers inject "' + h + '"');
      resenthdrs += h;
    }
  }

  //the msgCompFields fields are already quoted printable
  //encodeMimeHeader splits them into multiple lines
  resenthdrs += encodeMimeHeader("Resent-From: " + msgCompFields.from);
  if (msgCompFields.to) {
    resenthdrs += encodeMimeHeader("Resent-To: " + msgCompFields.to);
  }
  if (msgCompFields.cc) {
    resenthdrs += encodeMimeHeader("Resent-Cc: " + msgCompFields.cc);
  }
  //is not in the mails
  /*
  if (msgCompFields.bcc) {
    resenthdrs += encodeMimeHeader("Resent-Bcc: " + 'undisclosed recipients');
  }
*/
  if (!msgCompFields.to && !msgCompFields.cc) {
    let composeMsgsBundle = Services.strings.createBundle(
      "chrome://messenger/locale/messengercompose/composeMsgs.properties"
    );
    let undisclosedRecipients = composeMsgsBundle.GetStringFromName(
      "undisclosedRecipients"
    );
    resenthdrs += encodeMimeHeader(
      "Resent-To: " + undisclosedRecipients + ":;" + "\r\n"
    );
  }

  resenthdrs += "Resent-Date: " + getResentDate() + "\r\n";
  if (msgCompFields.messageId) {
    resenthdrs += "Resent-Message-ID: " + msgCompFields.messageId + "\r\n";
  }

  //debug('resent-headers\n'+resenthdrs);
  return resenthdrs;
}

function encodeMimePartIIStr_UTF8(aHeader, aFieldNameLen) {
  return MailServices.mimeConverter.encodeMimePartIIStr_UTF8(
    aHeader,
    true,
    aFieldNameLen,
    Ci.nsIMimeConverter.MIME_ENCODED_WORD_SIZE
  );
}
function encodeMimeHeader(header) {
  let fieldNameLen = header.indexOf(": ") + 2;
  if (header.length <= MAX_HEADER_LENGTH) {
    //header is already quoted printable, encodeMimePartIIStr_UTF8 splits them into multiple lines
    //    header = header.replace(/\r?\n$/, ""); // Don't encode closing end of line
    return (
      header.substr(0, fieldNameLen) + // and don't encode field name
      encodeMimePartIIStr_UTF8(header.substr(fieldNameLen), fieldNameLen) +
      "\r\n"
    );
  } else {
    //header too long, split into multiple headers(!)
    //    header = header.replace(/\r?\n$/, "");
    let fieldName = header.substr(0, fieldNameLen);
    let splitHeader = "";
    let currentLine = "";
    while (header.length > MAX_HEADER_LENGTH - 2) {
      let splitPos = header.substr(0, MAX_HEADER_LENGTH - 2).lastIndexOf(","); // Try to split before MAX_HEADER_LENGTH
      if (splitPos === -1) {
        splitPos = header.indexOf(","); // If that fails, split at first possible position
      }
      if (splitPos === -1) {
        currentLine = header;
        header = "";
      } else {
        currentLine = header.substr(0, splitPos);
        if (header.charAt(splitPos + 1) === " ") {
          header = fieldName + header.substr(splitPos + 2);
        } else {
          header = fieldName + header.substr(splitPos + 1);
        }
      }
      splitHeader +=
        currentLine.substr(0, fieldNameLen) + // Don't encode field name
        encodeMimePartIIStr_UTF8(
          currentLine.substr(fieldNameLen),
          fieldNameLen
        ) +
        "\r\n";
    }
    splitHeader +=
      header.substr(0, fieldNameLen) + // Don't encode field name
      encodeMimePartIIStr_UTF8(header.substr(fieldNameLen), fieldNameLen) +
      "\r\n";
    debug("long header: " + splitHeader);
    return splitHeader;
  }
}

function getResentDate() {
  let date = new Date();
  let mon = date.toLocaleString("en-US", { month: "short" });
  let dateTime =
    date.toLocaleString("en-US", { weekday: "short" }) +
    ", " +
    date.toLocaleString("en-US", { day: "numeric" }) +
    " " +
    date.toLocaleString("en-US", { month: "short" }) +
    " " +
    date.toLocaleString("en-US", { year: "numeric" }) +
    " " +
    date.toLocaleTimeString("de-DE") +
    " ";
  let offset = date.getTimezoneOffset();
  if (offset < 0) {
    dateTime += "+";
    offset *= -1;
  } else {
    dateTime += "-";
  }
  let minutes = offset % 60;
  offset = (offset - minutes) / 60;
  function twoDigits(aNumber) {
    return aNumber < 10 ? "0" + aNumber : aNumber.toString();
  }
  dateTime += twoDigits(offset) + twoDigits(minutes);
  debug("resentDate: " + dateTime);
  return dateTime;
}

function stylesheets(context, load) {
  let styleSheetService = Components.classes[
    "@mozilla.org/content/style-sheet-service;1"
  ].getService(Components.interfaces.nsIStyleSheetService);
  let uri = Services.io.newURI(
    context.extension.getURL("skin/simplemailredirection.css"),
    null,
    null
  );
  debug("stylesheet uri=" + uri.spec);
  if (load) {
    styleSheetService.loadAndRegisterSheet(uri, styleSheetService.USER_SHEET);
    debug("stylesheet loaded");
  } else {
    styleSheetService.unregisterSheet(uri, styleSheetService.USER_SHEET);
    debug("stylesheet unloaded");
  }
}

let debugcache = "";
function debug(txt) {
  let e = new Error();
  let stack = e.stack.toString().split(/\r\n|\n/);
  let ln = stack[1].replace(/moz-extension:\/\/.*\/(.*:\d+):\d+/, "$1"); //getExternalFilename@file:///D:/sourcen/Mozilla/thunderbird/Extensions/AddressbooksSync_wee/abs_utils.js:1289:6
  ln = ln.replace(/file:\/\/.*\/(.*:\d+):\d+/, "$1");
  if (!ln) ln = "?";

  if (prefs) {
    if (prefs.debug) {
      if (debugcache) {
        debugcache.split("\n").forEach((msg) => {
          if (msg) console.log(msg);
        });
        debugcache = "";
      }
      console.log("SMR: " + ln + " " + txt);
    }
  } else {
    debugcache += "SMR: (cached) " + ln + " " + txt + "\n";
  }
}
