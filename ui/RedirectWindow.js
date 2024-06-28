let prefs = {};

var msgs;
var wid;
var msgCount;
var allValid = false;
var sending = false;
var cardbook; //0: no cardbook, 1: only cardbook, 2: cardbook and TB
var cardbook_query = ""; // up to cardbook version <84.4
var mLists = new Map();
var origAcctId;
var sendOk = true;
var allowResend = false;
var doneText;
var inputTimer = null;
var results;
var lastSV;
let sonnAblageExtras = {
  rangeFromInput: null,
  rangeToInput: null,
  hashtagInput: null,
  validInputs: false,
};

function validate(elem) {
  const re =
    /^(?:.*<)?(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@.+$/i;
  let address = elem.value;
  //debug('validate '+address+' list? '+elem.name);
  if (elem.name && address.toLocaleLowerCase() != mLists.get(elem.name).lName)
    elem.name = ""; //no longer a valid list
  if (elem.name) {
    // a selected list
    elem.className = "address valid";
  } else if (!address) {
    elem.className = "address empty";
  } else if (re.test(address)) {
    elem.className = "address valid";
  } else {
    let found = false;
    mLists.forEach((list, id) => {
      if (address.toLocaleLowerCase() == list.lName) {
        found = true;
        elem.name = list.id; //save id of last found list
      }
    });
    if (found) {
      elem.className = "address valid";
    } else {
      elem.className = "address invalid";
      elem.name = "";
    }
  }
  let i = document.getElementsByClassName("address invalid").length;
  let v = document.getElementsByClassName("address valid").length;
  //debug('validate emails: valid='+v+' invalid='+i);
  if (!i && v) {
    document.getElementById("addressOK").disabled = false;
    // document.getElementById('default').disabled=false;
    allValid = true;
  } else {
    document.getElementById("addressOK").disabled = true;
    // if (i) document.getElementById('default').disabled=true;
    allValid = false;
  }
}

async function okAndInput(ev) {
  if (ev.repeat) {
    //debug('key repeated');
    return;
  }
  ev.stopPropagation();
  if (ev.type == "keydown") {
    let results = document.getElementById("results");
    if (ev.key == "Enter") {
      if (results) results.parentNode.removeChild(results);
      if (ev.target.value) {
        newInput(ev.target);
        validate(ev.target);
      } else if (ev.ctrlKey) {
        if (allValid) send();
      }
    } else if (ev.key == "ArrowDown" || ev.key == "Tab") {
      //debug('key down');
      if (results) {
        results.focus();
        results.firstChild.selected = true;
        ev.preventDefault(); //else results scrolls
      }
    } else if (ev.key == "Escape") {
      //debug('cancel (Escape)');
      removeWin();
    }
  }
}

async function send() {
  debug("sending messages wid=" + wid);
  let results = document.getElementById("results");
  if (results) results.parentNode.removeChild(results); //remove search resultsbox if still visible

  let [acct, iden] = document.getElementById("accountsel").value.split("|");
  debug("Account: " + acct + " " + iden);
  let addresses = [];
  let addr = document.getElementById("address");
  while (addr) {
    let to = addr.firstChild;
    let email = to.nextSibling;

    debug("addr: " + to.value + " " + email.value + " " + email.name);
    if (email.name) {
      let list = mLists.get(email.name);
      if (!list.isCB) {
        let contacts = await messenger.mailingLists.listMembers(list.id);
        debug("tb contacts: " + JSON.stringify(contacts));
        contacts.forEach((contact) => {
          let email = contact.properties.PrimaryEmail;
          if (email) {
            if (contact.properties.DisplayName)
              email =
                '"' + contact.properties.DisplayName + '" <' + email + ">";
            addresses.push({ to: to.value, email: email });
          }
        });
      } else {
        let emails = await messenger.runtime.sendMessage(
          "cardbook@vigneau.philippe",
          { query: cardbook_query + "lists", id: list.id }
        );
        emails.forEach((contact) => {
          email = contact.fn
            ? '"' + contact.fn + '" <' + contact.email + ">"
            : contact.email;
          addresses.push({ to: to.value, email: email });
        });
      }
    } else {
      if (email.value) addresses.push({ to: to.value, email: email.value });
    }
    addr = addr.nextSibling;
  }
  if (!addresses.length || !msgs.length) {
    debug("no addresses or no messages");
    return;
  }
  addresses = [...new Set(addresses)]; //remove duplicates
  debug(JSON.stringify(addresses));
  //return;	//debug

  msgCount = msgs.length;
  msgs.forEach((msg) => {
    debug("msg: " + msg.subject);
    let tr = document.getElementById("msg_" + msg.id);
    let tdpb = tr.firstChild.nextSibling.nextSibling;
    if (msg.hasOwnProperty("state")) {
      // its a resend
      if (!msg.state) {
        // message was already successfull sent
        //pb.innerHTML='';
        if (!doneText) doneText = messenger.i18n.getMessage("done");
        tdpb.firstChild.firstChild.textContent = doneText; //bereits verschickt
        tdpb.firstChild.firstChild.className = "textonly";
        msg.sending = false;
        msgCount--;
      } else if (msg.allowResend) {
        tr.style.color = "black";
        msg.sending = true;
      }
      tdpb.firstChild.classList.remove("hide");
    } else {
      //first send
      msg.sending = true;
      let pbd = document.createElement("div");
      pbd.className = "pb";
      let pbs = document.createElement("span");
      pbs.id = "pb_" + tr.id.substr(4);
      tr.firstChild.className = "abort";
      let pb = document.createElement("progress");
      pb.max = 100;
      pb.value = 0;
      pb.classList.add("invis");
      pbd.appendChild(pb);
      pbd.appendChild(pbs);
      tdpb.appendChild(pbd);
    }
  });

  let copy = document.getElementById("copy").checked;
  prefs.copytosent = copy;
  debug("copy=" + copy);
  prefs.identities[origAcctId] = acct + "|" + iden;
  await messenger.storage.local.set(prefs);

  sendOk = true;
  allowResend = false;

  messenger.smr.redirect(
    msgs,
    addresses,
    { accountId: acct, identityId: iden, copy2sent: copy },
    wid,
    prefs
  );
  sending = true;
  debug("send done");
  document.getElementById("addressOK").disabled = true; //disable send button
  let inps = document.getElementsByTagName("input");
  for (let inp of inps) if (inp.type == "text") inp.disabled = true; //disable all text input fields

  document
    .getElementsByTagName("body")[0]
    .scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
}

async function cancel(e) {
  debug("cancel clicked");
  if (sending) {
    msgs.forEach((msg) => {
      if (msg.sending) {
        debug("abort " + msg.id + " " + msg.subject);
        messenger.smr.abort(wid, Number(msg.id));
      }
    });
  } else {
    //its close
    removeWin();
  }
}

function removeMsg(ev) {
  let tr = ev.target.parentNode;
  let msgId = tr.id.substr(4);
  if (!sending) {
    debug("remove message " + msgId);
    let msgInd = msgs.findIndex((msg) => msg.id == msgId);
    let msg = msgs[msgInd];
    msgs.splice(msgInd, 1);
    tr.parentNode.removeChild(tr);
    if (!msg.hasOwnProperty("state") || msg.state) msgCount--;
    if (!msgCount) cancel();
  } else {
    debug("abort message " + msgId);
    messenger.smr.abort(wid, Number(msgId));
  }
}

async function openAB() {
  if (cardbook) {
    messenger.runtime.sendMessage("cardbook@vigneau.philippe", {
      query: cardbook_query + "openBook",
    });
  } else messenger.addressBooks.openUI();
}

let listener = function (data) {
  debug("onMailSent fired: " + JSON.stringify(data));
  if (data.type == "copied") {
    //only on test
    let pbs = document.getElementById("pb_" + data.msgid);
    let size = (Number(data.size) / 1000 / 1000).toFixed(2);
    size = size + "MB";
    pbs.textContent = size;
  } else if (data.type == "waiting") {
    let pbs = document.getElementById("pb_" + data.msgid);
    pbs.textContent = "...";
  } else if (data.type == "converting") {
    let pbs = document.getElementById("pb_" + data.msgid);
    //pbs.textContent='';
    pbs.previousSibling.classList.remove("invis"); // the progressbar
  } else if (data.type == "started") {
    let pbs = document.getElementById("pb_" + data.msgid);
    let size = (Number(data.size) / 1000 / 1000).toFixed(2);
    size = size + "MB";
    pbs.textContent = size;
    pbs.previousSibling.removeAttribute("value"); //start spinning
    pbs.previousSibling.removeAttribute("max"); //start spinning
  } else if (data.type == "finished" || data.type == "aborted") {
    let msg = msgs.find((msg) => msg.id == data.msgid);
    msg.sending = false;
    msg.state = data.state;
    msg.allowResend = data.allowResend;
    let pbs = document.getElementById("pb_" + data.msgid);
    pbs.previousSibling.classList.add("hide");
    pbs.textContent = "";
    let tr = document.getElementById("msg_" + data.msgid);
    tr.firstChild.removeEventListener("click", removeMsg);
    if (data.state == 0) {
      tr.style.color = "green";
      tr.firstChild.className = "ok";
      tr.getElementsByTagName("progress")[0].remove(); //remove progressbar
    } else {
      sendOk = false;
      tr.style.color = "red";
      tr.firstChild.className = "failed";
      if (data.allowResend) {
        allowResend = true;
        // with NS_ERROR_SENDING_RCPT_COMMAND (status 550)or
        // with NS_ERROR_SENDING_MESSAGE, web.de problem
        debug("Allow editing recipient address");
      }
    }
    msgCount--;
    if (!msgCount) {
      sending = false;
      debug("no more messages, allowResend=" + allowResend);
      if (allowResend) {
        document.getElementById("addressOK").disabled = false; //reenable send button
        let inps = document.getElementsByTagName("input");
        for (let inp of inps) if (inp.type == "text") inp.disabled = false; //reenable all text input fields
        msgCount = msgs.length; //reinitialize msgCount
        msgs.forEach((msg) => {
          if (!msg.state) msgCount--;
          let tr = document.getElementById("msg_" + msg.id);
          let td = tr.firstChild;
          //          td.className='remove';
          td.addEventListener("click", removeMsg);
          td.classList.add("pointer");
          //          if (!msg.state) tr.classList.add('done');
        });
      }
      document.getElementById("addressCANCEL").value =
        messenger.i18n.getMessage("close");
      if (sendOk && prefs.closeonsuccess)
        setTimeout(() => {
          removeWin();
        }, prefs.delay * 1000);
    }
  }
};

async function load() {
  wid = (await messenger.windows.getCurrent()).id;
  prefs = await messenger.storage.local.get({
    debug: false,
    delay: 1,
    size: 0,
    identities: {},
    changefrom: {},
    maxConn: {},
    copytosent: true,
    closeonsuccess: true,
    defaults: {},
    tbBooks: null,
    cbBooks: null,
    SonnResentDefaultAddr: [],
  });
  //dont use storage.local.get() (without arg), see https://thunderbird.topicbox.com/groups/addons/T46e96308f41c0de1
  if (!prefs.defaults["*"]) prefs.defaults["*"] = [];
  debug("load: wid=" + wid + " prefs=" + JSON.stringify(prefs));
  debug("  allowResend=" + allowResend);

  if (messenger.smr.onMailSent.hasListener(listener)) {
    debug("we already have a listener");
  }
  messenger.smr.onMailSent.addListener(listener, wid);

  document.getElementById("addressCANCEL").addEventListener("click", cancel);
  document.getElementById("addressOK").addEventListener("click", send);
  let email = document.getElementById("email");
  email.addEventListener("keydown", okAndInput);
  email.addEventListener("drop", drop);
  email.addEventListener("input", (ev) => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      search(ev);
    }, 10);
  }); //catch too quick input
  window.focus(); //neccessary since TB88 for email.focus() to work
  window.setTimeout(() => {
    email.focus();
  }, 200);
  results = document.createElement("select");
  results.id = "results";
  results.multiple = true;
  results.autocomplete = "off";
  results.style.display = "none";
  results.addEventListener("keyup", selectitem);
  results.addEventListener("keydown", selectitem);
  results.addEventListener("click", selectitem);
  //append 'results' to 'addresses' ??
  document.getElementById("ab").addEventListener("click", openAB);
  document.getElementById("body").addEventListener("keydown", bodykey);
  document
    .getElementById("accountsel")
    .addEventListener("change", accountchange);
  // document.getElementById("maxConn").addEventListener('change', changemaxconn);
  document
    .getElementById("changefrom")
    .addEventListener("change", togglechangefrom);
  // document.getElementById("closeonsuccess").addEventListener('change', togglecloseonsuccess);
  // document.getElementById("delay").addEventListener("change", changedelay);
  // document.getElementById("debug").addEventListener("change", toggledebug);
  // document.getElementById("default").addEventListener('click', setDefaultAddresses);
  // document.getElementById("default").addEventListener('mouseenter', tooltip);
  // document.getElementById("restore").addEventListener('click', restoreDefaultAddresses);
  // document.getElementById("restore").addEventListener('mouseenter', tooltip);
  document.getElementById("ab").addEventListener("mouseenter", tooltip);
  document
    .getElementById("deleteAddresses")
    .addEventListener("click", removeResentAddr);
  document
    .getElementById("extrasAblageButton")
    .addEventListener("click", toggleExtrasAblage);
  // document.getElementById("defName").addEventListener('input', (event)=>{
  //     if (event.target.value) event.target.classList.remove('defName');
  //                        else event.target.classList.add('defName');});

  let msgSubjects = "";
  msgs = await messenger.runtime.sendMessage({
    action: "requestData",
    prefs: prefs,
  });
  msgCount = msgs.length;
  let mails = document.getElementById("mails");
  let tbody = mails.firstChild;
  if (tbody.tagName != "tbody") tbody = tbody.nextSibling;
  msgs.forEach((msg) => {
    origAcctId = msg.folder.accountId; //use account from last mail
    // TODO: accounts may be different if mails come from a virtual folder
    msg.sending = false;
    let d = new Date(msg.date);
    let date = d.toLocaleString();
    let tr = document.createElement("tr");
    tr.id = "msg_" + msg.id;
    let td = document.createElement("td");
    td.textContent = " ";
    td.className = "remove";
    td.addEventListener("click", removeMsg);
    let img = document.createElement("img");
    td.appendChild(img);
    tr.appendChild(td);
    td = document.createElement("td");
    td.textContent = msg.subject;
    tr.appendChild(td);
    td = document.createElement("td"); //progressbar
    //td.className='pb';
    tr.appendChild(td);
    td = document.createElement("td");
    td.textContent = msg.author;
    tr.appendChild(td);
    td = document.createElement("td");
    td.textContent = date;
    tr.appendChild(td);
    tbody.appendChild(tr);
    if (msg.subject && msgSubjects.length === 0) {
      msgSubjects += msgSubjects + msg.subject;
    } else if (msg.subject) {
      msgSubjects += msgSubjects + " " + msg.subject;
    }
  });
  await addResentFiles(msgSubjects);

  let ae = document.getElementById("accountsel");
  let accounts;
  try {
    accounts = await messenger.accounts.list(); //array of MailAccount
  } catch (e) {
    debug("%-sign in foldernames problem, see bug 1684327");
    const msg =
      '<div style="color: red;"><div style="margin: 2em;">Bitte entfernen sie alle %-Zeichen aus Ordnernamen!<br/>\
Es gibt einen Fehler in Thunderbird, der die Ausführung dieses Add-ons verhindert.<br/>Siehe Bug 1684327</div>\
<div style="margin: 2em;">Please remove any %-signs from foldernames!<br/>\
There is a bug in Thunderbird which prevents this add-on from running.<br/>See Bug 1684327</div></div>';
    const parser = new DOMParser();
    const parsed = parser.parseFromString(msg, "text/html");
    const tags = parsed.getElementsByTagName("body");
    document.body = tags[0];
    return;
  }

  let defAcctId, defIdenId;
  let pref = prefs.identities[origAcctId];
  // if (pref) {
  //   let [acctId, idenId] = pref.split("|");
  //   debug("from prefs " + acctId + " " + idenId);
  //   //todo: check if acct and iden exists
  //   let acct = accounts.filter((acct) => acct.id == acctId)[0];
  //   let iden;
  //   if (acct) {
  //     //ok, account is valid
  //     iden = acct.identities.filter((iden) => iden.id == idenId)[0];
  //     if (!iden) {
  //       //identity no longer valid (probably deleted), use default (or first) identity
  //       debug("identity from prefs not valid, use default or first identity");
  //       iden = acct.identities[0];
  //     }
  //     defAcctId = acct.id;
  //     defIdenId = iden.id;
  //     debug("use from prefs " + defAcctId + " " + defIdenId);
  //   } else debug("account from prefs not valid");
  // }
  if (!defAcctId) {
    //not in prefs or invalid in prefs
    let defaultPref = await messenger.LegacyPrefs.getPref(
      "extensions.smr.defaultResentFrom"
    );
    let acct, iden;
    if (defaultPref) {
      for (acct of accounts) {
        iden = acct.identities.find((iden) => iden.email == defaultPref);
        if (iden !== undefined && iden !== null) {
          break;
        }
      }
    } else {
      acct = accounts.filter((acct) => acct.id == origAcctId)[0];
      iden = acct.identities[0];
    }
    if (iden) {
      // is the default identity or at least the first identity
      debug("Default Identity: " + iden.id + " in " + iden.accountId);
      defAcctId = acct.id;
      defIdenId = iden.id;
      debug("Use Identity: " + defIdenId + " in " + defAcctId);
    } else {
      //no identity e.g. local folders
      debug("no identity for " + origAcctId);
      for (let i = 0; i < accounts.length; i++) {
        //find first account with identities
        if (accounts[i].identities.length) {
          defAcctId = accounts[0].id;
          defIdenId = accounts[i].identities[0].id;
          debug("first usable acct/iden");
          break;
        }
      }
    }
  }
  debug("using " + defAcctId + " " + defIdenId);

  let border = false;
  accounts.forEach((account) => {
    if (account.identities.length) {
      //length==0 for local folders
      let bold = true;
      let o;
      account.identities.forEach((identity) => {
        o = document.createElement("option");
        o.value = account.id + "|" + identity.id;
        if (account.id == defAcctId && identity.id == defIdenId) {
          o.selected = true;
          // let mc=document.getElementById('maxConn');
          // mc.value=prefs.maxConn[o.value]??4; //TODO: should be indexed by smtp-server, not by account|identity
          // mc.name=o.value;
          let cf = document.getElementById("changefrom");
          let cfb = document.getElementById("changefromBox");
          cf.name = o.value;
          if (prefs.changefrom[o.value]) {
            cfb.style.display = "block";
            cf.checked = true;
          }
        }

        //        let a=identity.name+' &lt;'+identity.email+'&gt; ';
        let a = identity.name + " <" + identity.email + "> ";
        if (identity.label) a += "(" + identity.label + ") ";
        //        a+='<span class="acct">'+account.name+'</span>';
        a += account.name;
        //        o.innerHTML=a;
        o.textContent = a;
        if (bold) {
          o.className = "acct";
          if (!border && account.identities.length > 1) o.classList.add("bt"); //border-top
        }
        bold = false;
        border = false;
        ae.appendChild(o);
      });
      if (account.identities.length > 1) {
        o.classList.add("bb"); //border-bottom
        border = true;
      }
    }
  });

  document.getElementById("copy").checked = prefs.copytosent;
  // document.getElementById("closeonsuccess").checked=prefs.closeonsuccess
  document.getElementById("delay").value = prefs.delay;
  document.getElementById("debug").checked = prefs.debug;

  let body = document.getElementById("body");
  let size = prefs.size;
  if (!size) size = 12;
  prefs.size = 12;
  body.style.fontSize = size + "px";
  body.style.display = "block";

  // communication with cardbook, cardbook needs to use NotifyTools
  let have_cardbook = 0;
  cardbook = 0;
  try {
    let cbei = await messenger.management.get("cardbook@vigneau.philippe");
    if (cbei.enabled) {
      debug("cardbook version " + cbei.version); //70.9
      let [v, major, minor] = cbei.version.match(/^(\d+)\.(\d+)/);
      if (major < 70 || (major == 70 && minor <= 9))
        have_cardbook = 1; //no api or buggy api
      else have_cardbook = 2; //api ok
    } else debug("cardbook installed but disabled");
  } catch (e) {
    debug("cardbook not installed");
  }

  if (have_cardbook >= 2)
    try {
      let cb_apiVersion = await messenger.runtime.sendMessage(
        "cardbook@vigneau.philippe",
        { query: "version" }
      );
      if (!cb_apiVersion.hasOwnProperty("version")) {
        // since cardbook version >=84.4
        cardbook_query = "simpleMailRedirection.";
        cb_apiVersion = await messenger.runtime.sendMessage(
          "cardbook@vigneau.philippe",
          { query: cardbook_query + "version" }
        );
      }
      //returns {version: API_VERSION, exclusive: exclusive}
      debug("cardbook api version " + JSON.stringify(cb_apiVersion));
      cardbook = cb_apiVersion.exclusive ? 1 : 2;
      debug(
        "cardBook api 0=not available, 1=yes, 2=also use TB addressbook: " +
          cardbook
      );

      /*
let cbs=await messenger.runtime.sendMessage(
      'cardbook@vigneau.philippe', {query: cardbook_query+'getAddressBooks'});
debug('cardbook api books: '+JSON.stringify(cbs));
*/

      //collect names and ids of mailling lists
      let books = prefs.cbBooks; //restrict search to these books
      if (!books || books.length) {
        // search all or some books
        let cb_lists = await messenger.runtime.sendMessage(
          "cardbook@vigneau.philippe",
          { query: cardbook_query + "lists" }
        );
        debug("cardbook api all lists: " + JSON.stringify(cb_lists));
        if (books) {
          debug("restrict list to books: " + JSON.stringify(books));
          cb_lists = cb_lists.filter((l) => books.includes(l.abid));
        }
        debug("cardbook api lists filtered: " + JSON.stringify(cb_lists));
        for (let list of cb_lists) {
          debug("cardbook api list: " + list.name);
          mLists.set(list.id, {
            name: list.name,
            lName: list.name.toLocaleLowerCase(),
            isCB: true,
            id: list.id,
            parent: list.abname,
            parentid: list.abid,
            bcolor: list.bcolor,
            fcolor: list.fcolor,
          });
        }
      } else {
        debug("search: cardbook ml search not used");
      }
    } catch (e) {
      debug("cardbook api throws " + e);
      cardbook = 0; //old usage of cardbook no longer supported
    }
  else if (have_cardbook == 1) {
    debug("Don't use buggy cardbook api");
    cardbook = 0; //old usage of cardbook no longer supported
  }

  if (!cardbook || cardbook > 1) {
    // get TB's mailLists
    let books = prefs.tbBooks; //restrict search to these books
    if (!books || books.length) {
      let abs = await messenger.addressBooks.list();
      for (const ab of abs) {
        //ab.id, ab.name
        //debug('ab: '+JSON.stringify(ab));
        if (books && !books.includes(ab.id)) continue;
        debug("tb ml: check book " + ab.id + " " + ab.name);
        let mls = await messenger.mailingLists.list(ab.id);
        for (const ml of mls) {
          //ml.id, ml.parentId, ml.name, ml.nickName, ml.description
          ml.lName = ml.name.toLocaleLowerCase();
          ml.abName = ab.name;
          ml.isCB = false;
          ml.parent = ab.name;
          ml.bcolor = "";
          ml.fcolor = "";
          mLists.set(ml.id, ml);
          debug("tb ml: add " + JSON.stringify(ml));
        }
      }
    }
  }
  debug(
    "lists: " + mLists.size + " " + JSON.stringify(Array.from(mLists.entries()))
  );

  // builddatalist();
  // restoreDefaultAddresses('*');  // restore default set
}

function accountchange(ev) {
  let acct = ev.target.value;
  debug("account now " + acct);
  // let mc=document.getElementById('maxConn');
  // mc.value=prefs.maxConn[acct]??4; //TODO: should be indexed by smtp-server, not by account|identity
  let cf = document.getElementById("changefrom");
  let cfb = document.getElementById("changefromBox");
  cf.name = acct;
  if (prefs.changefrom[acct]) {
    cfb.style.display = "block";
    cf.checked = true;
  } else {
    cfb.style.display = "none";
    cf.checked = false;
  }
  prefs.identities[origAcctId] = acct;
  messenger.storage.local.set(prefs);
}

function changemaxconn(ev) {
  prefs.maxConn[ev.target.name] = ev.target.value; //TODO: should be indexed by smtp-server, not by account|identity
  debug(
    "maxConn for " + ev.target.name + " now " + prefs.maxConn[ev.target.name]
  );
  debug(JSON.stringify(prefs));
  messenger.storage.local.set(prefs);
}
function togglechangefrom(ev) {
  prefs.changefrom[ev.target.name] = ev.target.checked;
  debug(
    "changefrom for " +
      ev.target.name +
      " now " +
      (prefs.changefrom[ev.target.name] ? "on" : "off")
  );
  debug(JSON.stringify(prefs));
  messenger.storage.local.set(prefs);
}

async function search(ev) {
  inputTimer = null;
  validate(ev.target);
  let sv = ev.target.value;
  debug("search: " + sv);
  if (sv.length < 2) {
    results.style.display = "none";
    return;
  }

  //Multiple search requests might be spawned before first results are delivered
  //And the results of an earlier search might even be delivered after a later search
  //This might happen with ldap addressbooks
  lastSV = sv;
  /*
if (sv=='ger') { 
  setTimeout(()=>{ev.target.value='gers'; search(ev)}, 1); 
  setTimeout(()=>{ev.target.value='gersd'; search(ev)}, 2); 
  setTimeout(()=>{ev.target.value='gers'; search(ev)}, 3); 
  setTimeout(()=>{ev.target.value='mari'; search(ev)}, 4); 
} //TEST very quick search request
*/
  let addresses = [];
  let lists = [];
  let re = new RegExp(sv, "i");
  for (const list of mLists.values()) {
    if (list.lName.match(re)) {
      lists.push({
        list: list.name,
        id: list.id,
        bcolor: list.bcolor,
        fcolor: list.fcolor,
        isCB: list.isCB,
        parent: list.parent,
      });
    }
  }

  if (cardbook) {
    //0: no cardbook, 1: only cardbook, 2: cardbook and TB
    let books = prefs.cbBooks; //restrict search to these books
    if (!books || books.length) {
      //null means: search all books
      debug("search: cardbook search books " + JSON.stringify(books));
      let contacts = await messenger.runtime.sendMessage(
        "cardbook@vigneau.philippe",
        {
          query: cardbook_query + "contacts",
          search: sv /*+' @'*/,
          books: books,
        }
      );
      //debug('cardbook contacts: '+JSON.stringify(contacts));
      for (let contact of contacts) {
        for (let l = 0; l < contact.email.length; l++) {
          addresses.push({
            email: '"' + contact.fn + '" <' + contact.email[l][0][0] + ">",
            bcolor: contact.bcolor,
            fcolor: contact.fcolor,
          });
        }
      }
    } else {
      debug("search: cardbook search not used");
    }
  }
  debug(
    "search: cardbook search for " +
      sv +
      " returned " +
      addresses.length +
      " entries"
  );

  if (!cardbook || cardbook > 1) {
    debug("search: calling quickSearch for " + sv);
    let books = prefs.tbBooks; //restrict search to these books

    let nodes = [];
    if (!books) {
      //null means: search all books
      debug("search: quickSearch all books");
      nodes = await messenger.contacts.quickSearch(null, '"' + sv + '"');
    } else if (books && books.length) {
      debug("search: quickSearch only " + JSON.stringify(books));
      let bp = [];
      for (const id of books) {
        bp.push(messenger.contacts.quickSearch(id, '"' + sv + '"'));
      }
      bp = await Promise.all(bp); // wait till all searches has delivered
      for (const id of books) {
        let n = bp.shift();
        nodes = nodes.concat(n);
        debug("search: book " + id + " returned " + n.length + " entries");
      }
    } else {
      debug("search: quickSearch not used");
    }
    debug(
      "search: quickSearch for " + sv + " returned " + nodes.length + " entries"
    );
    /*
debug('search: '+sv);
		let nodes=await messenger.contacts.quickSearch(null, sv);
*/
    nodes.forEach((node) => {
      //debug('contact: '+JSON.stringify(node));
      if (node.properties.PrimaryEmail)
        addresses.push({
          email: node.properties.DisplayName
            ? '"' +
              node.properties.DisplayName +
              '" <' +
              node.properties.PrimaryEmail +
              ">"
            : node.properties.PrimaryEmail,
        });
      if (node.properties.SecondEmail)
        addresses.push({
          email: node.properties.DisplayName
            ? '"' +
              node.properties.DisplayName +
              '" <' +
              node.properties.SecondEmail +
              ">"
            : node.properties.SecondEmail,
        });
    });
  }

  if (sv != lastSV) {
    //ignore result if not the last search request
    debug("search: search for " + sv + " not last search, which is " + lastSV);
    return;
  }

  debug("search: found total addresses: " + addresses.length);

  //remove duplicates
  let emails = new Set();
  const uAddresses = addresses.filter((m) => {
    //unique addresses
    if (!emails.has(m.email)) return emails.add(m.email);
    else return false;
  });
  addresses = lists.concat(uAddresses);
  debug("search: after removing duplicates: " + addresses.length);

  //debug('found '+addresses.length);
  if (addresses.length && addresses.length <= 50) {
    debug("search: show results for " + sv);
    while (results.firstChild) results.removeChild(results.lastChild);
    results.style.display = "block";
    results.size = addresses.length <= 5 ? addresses.length : 5;
    addresses.forEach((address) => {
      let opt = document.createElement("option");
      if (address.email) {
        //email
        opt.text = address.email;
        opt.value = "|" + address.email;
      } else {
        //list
        opt.text =
          address.list +
          "/" +
          (cardbook == 2 ? (address.isCB ? "CB:" : "TB:") : "") +
          address.parent;
        opt.value = address.id + "|" + address.list;
      }
      if (address.bcolor) {
        opt.style.backgroundColor = address.bcolor;
        opt.style.color = address.fcolor;
      }
      results.appendChild(opt);
    });
    ev.target.parentNode.parentNode.insertBefore(
      results,
      ev.target.parentNode.nextSibling
    ); //appends if no nextSibling
    results.scrollIntoView(false);
  } else {
    //list too long
    results.style.display = "none";
  }
}

function selectitem(ev) {
  if (
    (ev.type == "keydown" && ev.key == "Tab") ||
    (ev.type == "keyup" && (ev.key == "Enter" || ev.key == " ")) ||
    ev.type == "click"
  ) {
    ev.stopPropagation();
    ev.preventDefault();
    let input = results.previousSibling.firstChild.nextSibling;
    results.parentNode.removeChild(results);
    let data = ev.target.value.split("|");
    input.name = data.shift(); //list id or ''
    input.value = data.join("|"); //??? why? but should probably use ev.target.text
    //debug('selected: list='+input.name+' value='+input.value+' text='+ev.target.text);
    validate(input);
    input.focus();
    newInput(input);
  }
}
function drop(ev) {
  results.style.display = "none";
  let address = ev.dataTransfer.getData("text");
  debug("dropped " + address);
  if (!ev.target.value)
    //else its a replace
    newInput(ev.target);
  ev.target.value = address;
  validate(ev.target);
  ev.preventDefault();
}
function newInput(elem) {
  //debug('generate new input field');
  let addr = elem.parentNode; //flex container
  let to = addr.firstChild.value;
  let na = addr.nextSibling;
  //debug('newInput next is '+ni);
  if (!na) {
    na = addr.cloneNode(true);
    na.removeAttribute("id");
    na.firstChild.value = to;
    let ni = na.firstChild.nextSibling;
    ni.removeAttribute("id");
    ni.value = "";
    ni.name = "";
    ni.className = "empty";
    ni.addEventListener("keydown", okAndInput);
    ni.addEventListener("drop", drop);
    ni.addEventListener("input", (ev) => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        search(ev);
      }, 10);
    }); //catch too quick input
    addr.parentNode.appendChild(na);
    ni.focus();
  }
  document.getElementsByTagName("body")[0].scrollIntoView(false);
  return na;
}

let hidden = "";
async function bodykey(ev) {
  if (ev.repeat) {
    //debug('key repeated');
    return;
  }
  if (ev.type == "keydown") {
    let resize = false;
    if (ev.key == "+" && ev.ctrlKey) {
      prefs.size++;
      resize = true;
    } else if (ev.key == "-" && ev.ctrlKey) {
      prefs.size--;
      resize = true;
    } else if (ev.key == "0" && ev.ctrlKey) {
      prefs.size = 12;
      resize = true;
    } else if (ev.key == "Enter" && ev.ctrlKey) {
      if (allValid) send();
    } else if (ev.key == "s" && !hidden) {
      hidden = "s";
    } else if (ev.key == "m" && hidden == "s") {
      hidden = "m";
    } else if (ev.key == "r" && hidden == "m") {
      hidden = "";
      document.getElementById("debugbox").style.display = "inline-block";
    } else if (ev.key == "r" && !hidden) {
      hidden = "r";
    } else if (ev.key == "w" && hidden == "r") {
      hidden = "w";
    } else if (ev.key == "f" && hidden == "w") {
      hidden = "";
      document.getElementById("changefromBox").style.display = "block";
    } else {
      hidden = "";
    }
    if (resize) {
      let body = document.getElementById("body");
      let size = prefs.size;
      body.style.fontSize = size + "px";
      hidden = "";
    }
  }
}
function setDefaultAddresses() {
  debug("set default addresses");
  let defaults = [];
  let addr = document.getElementById("address");
  while (addr) {
    if (addr.id == "results") {
      addr = addr.nextSibling;
      continue;
    } //skip search results box
    let to = addr.firstChild;
    let email = to.nextSibling;
    debug(
      "setDefault: To:" +
        to.value +
        " Val:" +
        email.value +
        " Name:" +
        email.name
    );
    if (email.value)
      defaults.push({ to: to.value, email: email.value, list: email.name });
    addr = addr.nextSibling;
  }
  defaultsName = document.getElementById("defName").value;
  if (defaultsName == "") defaultsName = "*";
  debug("set default addresses for set " + defaultsName);
  if (defaults.length || defaultsName == "*")
    prefs.defaults[defaultsName] = defaults;
  else delete prefs.defaults[defaultsName];
  builddatalist();
  messenger.storage.local.set(prefs);
}
function restoreDefaultAddresses(defaultsName) {
  if (typeof defaultsName !== "string")
    defaultsName = document.getElementById("defName").value;
  if (defaultsName == "") defaultsName = "*";
  debug('restore defaults from set "' + defaultsName + '"');
  let addr = document.getElementById("address");
  while (addr.nextSibling) addr.nextSibling.remove();
  let defaults = prefs?.defaults?.[defaultsName];
  // every non existing defaults set clears the list of addresses
  if (!defaults?.length) defaults = [{ to: "TO", email: "", list: "" }];
  debug("restored addresses: " + JSON.stringify(defaults));
  for (let def of defaults) {
    let to = addr.firstChild;
    to.value = def.to;
    let email = to.nextSibling;
    email.value = def.email;
    email.name = def.list;
    validate(email);
    if (def.email) addr = newInput(email);
  }
}
function builddatalist() {
  let dl = document.getElementById("defNames");
  while (dl.hasChildNodes()) dl.lastChild.remove();
  let opt = document.createElement("option");
  opt.text = "*";
  dl.appendChild(opt);
  for (let name in prefs?.defaults) {
    //    if (!prefs.defaults.hasOwnProperty(name)) continue;
    //debug('add '+name+' to datalist');
    if (name == "*" || name == "") continue;
    let opt = document.createElement("option");
    opt.text = name;
    dl.appendChild(opt);
  }
}

function toggledebug(ev) {
  prefs.debug = ev.target.checked;
  debug("debug now " + (prefs.debug ? "on" : "off"));
  messenger.storage.local.set(prefs);
  messenger.smr.init(prefs); //inform implementation.js
}
function togglecloseonsuccess(ev) {
  prefs.closeonsuccess = ev.target.checked;
  debug("closeonsuccess now " + (prefs.closeonsuccess ? "on" : "off"));
  messenger.storage.local.set(prefs);
}
function changedelay(ev) {
  prefs.delay = ev.target.value;
  debug("delay now " + prefs.delay);
  messenger.storage.local.set(prefs);
}
function tooltip(ev) {
  let title = ev.target.title;
  let tt = document.getElementById("tooltip");
  tt.textContent = title;
  tt.style.display = "block";
  let pos = ev.target.getBoundingClientRect();
  if (ev.target.id == "ab") {
    tt.style.right = document.documentElement.clientWidth - pos.right + "px";
    tt.style.left = "unset";
  } else {
    tt.style.left = pos.left + window.scrollX + "px";
    tt.style.right = "unset";
  }
  tt.style.top = pos.bottom + window.scrollY + "px";
  ev.target.addEventListener("mouseleave", function ml() {
    this.removeEventListener("mouseleave", ml);
    tt.style.display = "none";
  });
}

async function removeWin() {
  let win = await messenger.windows.getCurrent();
  let wInfo = await messenger.windows.get(win.id);
  prefs.top = wInfo.top;
  prefs.left = wInfo.left;
  prefs.height=wInfo.height;
  prefs.width = wInfo.width;
  await messenger.storage.local.set(prefs);
  debug("positioned window now at " + prefs.left + "x" + prefs.top);
  debug("sized window now " + prefs.width); //+'x'+prefs.height);
  debug("font size now " + prefs.size);

  await messenger.windows.remove(win.id);
}

document.addEventListener("DOMContentLoaded", load, { once: true });
// window close is recognized by unregister of onMailSent

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

// SONN Functions

async function addResentFiles(subjects) {
  let fileMatch = subjects.match(
    /\b(([MRU]\s?\d{4,5}\/[A-Z]{1,2}(?!\/)|J\s?\d{4,5}\/\d{1,3}|[MGURKE]\s?\d{4,5}|S\s?\d{3})(?!-))\b/gi
  );

  let sentTypes = ["To", "Cc", "Bcc"];
  sentTypes.forEach((sentType) => {
    let prefSentItems = prefs.SonnResentDefaultAddr[sentType];
    //console.log("prefSentItems: ", prefSentItems);
    if (!prefSentItems) {
      return;
    }

    let mailAddresses = prefSentItems.split(/,\s?/);
    mailAddresses.forEach((mailAddr) => {
      //console.log("mailAddr: ", mailAddr);
      addResentAddr(mailAddr, sentType);
    });
  });

  if (fileMatch) {
    // remove duplicate values
    let uniqueSet = new Set(fileMatch);
    fileMatch = [...uniqueSet];
    for (let m of fileMatch) {
      let fileRaw = m.replace(/ /g, "");
      console.log("fileRaw: ", fileRaw);
      if (fileRaw.match(/\b([RGMUEJK]\d{4})\b/i)) {
        fileRaw =
          fileRaw.toLowerCase().substring(0, 1) +
          "0" +
          fileRaw.toUpperCase().substring(1);
      } else if (fileRaw.match(/\b(S\d{3})\b/i)) {
        fileRaw =
          fileRaw.toLowerCase().substring(0, 1) +
          "00" +
          fileRaw.toUpperCase().substring(1);
      } else {
        fileRaw =
          fileRaw.toLowerCase().substring(0, 1) +
          fileRaw.toUpperCase().substring(1);
      }
      let file = fileRaw.replace(/\//g, "-") + "@ablage";
      addResentAddr(file);
    }
  }

  let addHeight = document.querySelectorAll("div.address:not(#address)").length;
  //console.log("addHeight: ", addHeight);
  await changeWindowHeight(addHeight);
}

function addResentAddr(mailAddr, sentType = 0) {
  let mailAddrInput = document.getElementsByClassName("empty")[0];

  // set sentType To,Cc,Bcc
  if (sentType !== 0) {
    //console.log("sentType: ", sentType);
    mailAddrInput.previousSibling.value = sentType.toUpperCase();
  }
  mailAddrInput.value = mailAddr;

  // fake keypress event
  let mailAddr_ev = {
    type: "keydown",
    key: "Enter",
    target: mailAddrInput,
    stopPropagation: function () {},
  };
  okAndInput(mailAddr_ev);
}

async function removeResentAddr() {
  let addr = document.querySelectorAll("div.address:not(#address)");

  if (addr.length > 0) {
    //console.log("addr: ", addr);
    addr.forEach((elem) => elem.remove());
  }

  let firstAddr = document.querySelector("div#address");
  if (firstAddr) {
    let firstAddrMail = firstAddr.firstChild.nextSibling;
    if (firstAddrMail) {
      firstAddrMail.value = "";
      firstAddrMail.className = "address empty";
      document.getElementById("addressOK").disabled = true;
    }
  }
  document.getElementsByClassName("empty")[0].focus();

  await changeWindowHeight(-addr.length);
}

async function changeWindowHeight(count = 0) {
  let winRedirect = await messenger.windows.getCurrent();
  //console.log("changeWindowHeight Count: ", count);
  let height = winRedirect.height + count * 40;

  // fixed minimal height
  height = height > 300 ? height : 300;

  //console.log("winRedirect height", winRedirect.height);
  await messenger.windows.update(winRedirect.id, {
    height: height,
  });
  //console.log("neue Höhe: ", height);
}

function toggleExtrasAblage() {
  let div = document.querySelector("#dropdownAblage");
  //console.log("classList: ", div.classList);
  div.classList.toggle("showDropdown");
  if (div.classList.contains("showDropdown")) {
    document.querySelectorAll(".extrasAblageInput").forEach((elem) => {
      elem.addEventListener("input", extrasAblageValidate);
    });
    document
      .getElementById("extrasAblageSubmit")
      .addEventListener("click", extrasAblage);
  } else {
    document.querySelectorAll(".extrasAblageInput").forEach((elem) => {
      elem.removeEventListener("input", extrasAblageValidate);
    });
    document
      .getElementById("extrasAblageSubmit")
      .removeEventListener("click", extrasAblage);
  }
}

async function extrasAblage(ev) {
  if (!sonnAblageExtras.validInputs) {
    return;
  }

  let hashtag = "";
  if (sonnAblageExtras.hashtagInput !== "") {
    hashtag = "#" + sonnAblageExtras.hashtagInput;
  }

  if (
    sonnAblageExtras.rangeFromInput === "" &&
    sonnAblageExtras.rangeToInput === ""
  ) {
    addHashtag(hashtag);
  } else {
    let rangeFrom, rangeTo;
    let fileType = sonnAblageExtras.rangeFromInput.slice(0, 1).toLowerCase();
    rangeFrom = sonnAblageExtras.rangeFromInput.slice(1);
    rangeTo = sonnAblageExtras.rangeToInput.slice(1);

    let rangeCount = rangeTo - rangeFrom;
    document.getElementById("extrasAblageSubmit").disabled =
      rangeCount < 0 || rangeCount > 29;
    if (rangeCount > 29) {
      document.querySelector("#rangeLimit").classList.add("invalid");
      return;
    } else if (rangeCount < 0) {
      document.querySelector("#rangeToInput").classList.add("invalid");
      return;
    }
    document.querySelector("#rangeToInput").classList.remove("invalid");
    document.querySelector("#rangeLimit").classList.remove("invalid");

    let file;
    for (file = rangeFrom; file <= rangeTo; file++) {
      addResentAddr(fileType + file + hashtag + "@ablage");
    }

    let addHeight = document.querySelectorAll(
      "div.address:not(#address)"
    ).length;
    //console.log("addHeight: ", addHeight);
    await changeWindowHeight(addHeight);
  }
  toggleExtrasAblage();
}

async function extrasAblageValidate(ev) {
  // input id's validate input rangeFromInput, rangeToInput, hashtagInput
  let elem = ev.target;

  let re =
    /^\b(([MRU]\s?\d{4,5}\/[A-Z]{1,2}(?!\/)|J\s?\d{4,5}|[MGURKE]\s?\d{4,5}|S\s?\d{3})(?!-))\b$/i;
  if (elem.id === "hashtagInput") {
    // TODO extend regex?
    re = /^[a-zA-Z1-9\-]+$/i;
  }

  if (elem.value === "") {
    elem.classList.remove("invalid");
  } else if (re.test(elem.value)) {
    elem.classList.remove("invalid");
  } else {
    elem.classList.add("invalid");
  }

  let inputInvalidCount = 0;
  let inputRangeCount = 0;
  // input  id's
  let inputFields = ["rangeFromInput", "rangeToInput", "hashtagInput"];
  inputFields.forEach((inputField) => {
    let domElem = document.querySelector("#" + inputField);

    if (inputField !== "hashtagInput" && domElem.value !== "") {
      inputRangeCount += 1;
    }

    if (domElem.classList.contains("invalid")) {
      inputInvalidCount += 1;
    } else {
      sonnAblageExtras[inputField] = domElem.value;
    }
  });

  // check if only one inputRange field has a value
  if (inputRangeCount === 1) {
    inputInvalidCount += 1;
  }

  // set validInputs to true, if inputs are valid
  sonnAblageExtras.validInputs = inputInvalidCount === 0;
  document.getElementById("extrasAblageSubmit").disabled =
    inputInvalidCount !== 0;
}

function addHashtag(hashtag = "") {
  let addr = document.querySelectorAll("div.address>input.address");
  addr.forEach((elem) => {
    // check if input is empty or has already a hashtag #
    if (elem.value === "" || elem.value.includes("#")) {
      return;
    }
    let mailAddr = elem.value;
    let idx = mailAddr.lastIndexOf("@");
    if (idx > -1) {
      mailAddr = mailAddr.substr(0, idx) + hashtag + mailAddr.substr(idx);
    }
    elem.value = mailAddr;
  });
}
