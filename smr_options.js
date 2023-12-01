let prefs={};
let cbCount=0;
let tbCount=0;
let cblength=0;
let tbLength=0;

async function load() {
  wid=(await messenger.windows.getCurrent()).id;
  prefs=await messenger.storage.local.get({debug: false, delay: 2, size: 0,
      identities: {}, changefrom: {}, maxConn: {},
      copytosent: false, closeonsuccess: true, defaults: {},
      tbBooks: null, cbBooks: null
  });
debug('prefs: '+JSON.stringify(prefs));

  let cardbook=0;
  let apiversion=0;
	try {
		let cbei=await messenger.management.get('cardbook@vigneau.philippe');
    if (cbei.enabled) {
debug('cardbook version '+cbei.version);	//70.9
      let [v, major, minor]=cbei.version.match(/^(\d+)\.(\d+)/);
      if (major<70 || major==70 && minor<=9)
        cardbook=0;	//no api or buggy api
      else
        cardbook=1;	//api ok
    }
else debug('cardbook installed but disabled');
	} catch(e) {
debug('cardbook not installed');
	}
debug('cardbook='+cardbook);

  if (cardbook) try {
    let cb_apiVersion=await messenger.runtime.sendMessage(
          'cardbook@vigneau.philippe', {query: 'version'});
    if (!cb_apiVersion.hasOwnProperty('version')) { // since cardbook version >=84.4
      cardbook_query='simpleMailRedirection.';
      cb_apiVersion=await messenger.runtime.sendMessage(
          'cardbook@vigneau.philippe', {query: cardbook_query+'version'});
    }
    apiversion=cb_apiVersion.version;
      //returns {version: API_VERSION, exclusive: exclusive}
debug('cardbook api version '+JSON.stringify(cb_apiVersion));
    cardbook=cb_apiVersion.exclusive?1:2;
debug('now cardbook='+cardbook);
  } catch(e) {
debug('cardbook throws '+e);
//might throw: "Error: Could not establish connection. Receiving end does not exist."
//if cardbook without api (should not happen because of test for version number)
//or cardbook not yet ready
    pleasereopen();
    return;
  }

  if (cardbook) {
debug('Show cardbook books');
    document.getElementById('AllCB').addEventListener('click', toggleBook);
    if (apiversion<2) {
      if (prefs.cbBooks) {
        prefs.cbBooks=null; //with api version <2 always search all books
debug('pref.cbBooks now: '+JSON.stringify(prefs.cbBooks));
        messenger.storage.local.set({cbBooks: prefs.cbBooks});
      }
      document.getElementById('cbss').style.display='none';
    } else {
      let cbs=await messenger.runtime.sendMessage(
            'cardbook@vigneau.philippe', {query: cardbook_query+'getAddressBooks'});
      cbLength=cbs.length;
      if (!cbLength) {
        //cardbook might still not be ready
debug('cardbook not yet ready, wait...');
        setTimeout(load, 1000);
        return;
      }
debug('CB: books length '+cbLength+' '+JSON.stringify(cbs));
      let books=document.getElementById('cbbooks')
      cbs.forEach((b)=>{
        let d=document.createElement('div');
        let i=document.createElement('input');
        i.id=b.id;
        i.type='checkbox';
        i.className='CB';
        if (prefs.cbBooks && prefs.cbBooks.includes(b.id)) { i.checked=true; cbCount++; }
        i.addEventListener('click', toggleBook);
        let l=document.createElement('label');
        l.htmlFor=b.id;
        l.textContent=b.name;
        if (b.bcolor) {
          l.style.backgroundColor=b.bcolor;
          l.style.color=b.fcolor;
        }
        d.appendChild(i);
        d.appendChild(l);
        books.appendChild(d);
      });
    }
    if (!prefs.cbBooks) document.getElementById('AllCB').checked=true;
    document.getElementById('cardbook').style.display='block';
  } else {
    document.getElementById('cardbook').style.display='none';
  }

	if (!cardbook || cardbook>1) {
debug('No cardbook or cardbook+thunderbird: show tb books');
    document.getElementById('AllTB').addEventListener('click', toggleBook);
    if (!prefs.tbBooks) document.getElementById('AllTB').checked=true;
    let abs=await messenger.addressBooks.list();
    tbLength=abs.length;
//debug('thunderbird books: '+JSON.stringify(abs));
debug('TB: books length '+tbLength);
    let books=document.getElementById('tbbooks')
    abs.forEach((b)=>{
      let d=document.createElement('div');
      let i=document.createElement('input');
      i.id=b.id;
      i.type='checkbox';
      i.className='TB';
      if (prefs.tbBooks && prefs.tbBooks.includes(b.id)) { i.checked=true; tbCount++; }
      i.addEventListener('click', toggleBook);
      let l=document.createElement('label');
      l.htmlFor=b.id;
      l.textContent=b.name;
      d.appendChild(i);
      d.appendChild(l);
      books.appendChild(d);
    });
    document.getElementById('thunderbird').style.display='block';
  } else {
    document.getElementById('thunderbird').style.display='none';
  }
}

function toggleBook() {
debug('toggle '+this.id+' "'+this.nextSibling?.textContent+'" '+this.className);
  if (this.className=='CB') {
    if (this.id=='AllCB') {
      if (this.checked) {
debug('CB: all checked, uncheck all single books');
        Array.prototype.forEach.call(document.getElementsByClassName('CB'), e=>e.checked=false);
        document.getElementById('AllCB').checked=true;
        prefs.cbBooks=null;
debug('pref.cbBooks now: '+JSON.stringify(prefs.cbBooks));
        messenger.storage.local.set({cbBooks: prefs.cbBooks});
        cbCount=0;
      } else {
debug('CB: all unchecked, disable cardbook');
        prefs.cbBooks=[];
debug('pref.cbBooks now: '+JSON.stringify(prefs.cbBooks));
        messenger.storage.local.set({cbBooks: prefs.cbBooks});
        cbCount=0;
      }
    } else {
      if (this.checked) {
debug('CB: some book checked, uncheck the all books');
        cbCount++;
        if (cbCount==cbLength) {
debug('CB: All books now checked, check the all books');
          Array.prototype.forEach.call(document.getElementsByClassName('CB'), e=>e.checked=false);
          document.getElementById('AllCB').checked=true;
          cbCount=0;
          prefs.cbBooks=null;
debug('pref.cbBooks now: '+JSON.stringify(prefs.cbBooks));
          messenger.storage.local.set({cbBooks: prefs.cbBooks});
        } else {
          document.getElementById('AllCB').checked=false;
          if (!prefs.cbBooks) prefs.cbBooks=[];
          prefs.cbBooks.push(this.id);
debug('pref.cbBooks now: '+JSON.stringify(prefs.cbBooks));
          messenger.storage.local.set({cbBooks: prefs.cbBooks});
        }
      } else {
        cbCount--;
debug('CB: some unchecked, remove from prefs');
        let pos=prefs.cbBooks.findIndex((e)=>e==this.id);
        prefs.cbBooks.splice(pos, 1);
debug('pref.cbBooks now: '+JSON.stringify(prefs.cbBooks));
        messenger.storage.local.set({cbBooks: prefs.cbBooks});
      }
    }
  } else {  //TB
    if (this.id=='AllTB') {
      if (this.checked) {
debug('TB: all checked, uncheck all single books');
        Array.prototype.forEach.call(document.getElementsByClassName('TB'), e=>e.checked=false);
        document.getElementById('AllTB').checked=true;
        prefs.tbBooks=null;
debug('pref.tbBooks now: '+JSON.stringify(prefs.tbBooks));
        messenger.storage.local.set({tbBooks: prefs.tbBooks});
        tbCount=0;
      } else {
debug('TB: all unchecked, disable thunderbird');
        prefs.tbBooks=[];
debug('pref.tbBooks now: '+JSON.stringify(prefs.tbBooks));
        messenger.storage.local.set({tbBooks: prefs.tbBooks});
        tbCount=0;
      }
    } else {
      if (this.checked) {
debug('TB: some book checked, uncheck the all books');
        tbCount++;
        if (tbCount==tbLength) {
debug('TB: All books now checked, check the all books');
          Array.prototype.forEach.call(document.getElementsByClassName('TB'), e=>e.checked=false);
          document.getElementById('AllTB').checked=true;
          tbCount=0;
          prefs.tbBooks=null;
debug('pref.tbBooks now: '+JSON.stringify(prefs.tbBooks));
          messenger.storage.local.set({tbBooks: prefs.tbBooks});
        } else {
          document.getElementById('AllTB').checked=false;
          if (!prefs.tbBooks) prefs.tbBooks=[];
          prefs.tbBooks.push(this.id);
debug('pref.tbBooks now: '+JSON.stringify(prefs.tbBooks));
          messenger.storage.local.set({tbBooks: prefs.tbBooks});
        }
      } else {
        tbCount--;
debug('TB: some unchecked, remove from prefs');
        let pos=prefs.tbBooks.findIndex((e)=>e==this.id);
        prefs.tbBooks.splice(pos, 1);
debug('pref.tbBooks now: '+JSON.stringify(prefs.tbBooks));
        messenger.storage.local.set({tbBooks: prefs.tbBooks});
      }
    }
  }
}
function pleasereopen() {
  let tb=document.getElementById('tbbooks');
  while (tb.lastChild) tb.removeChild(tb.lastChild);
  let cb=document.getElementById('cbbooks');
  if (cb) while (cb.lastChild) cb.removeChild(cb.lastChild);
  document.getElementById('cardbook').style.display='none';
  document.getElementById('thunderbird').style.display='none';
  document.getElementById('pleasereopen').style.display='block';
}

document.addEventListener('DOMContentLoaded', load, { once: true });
messenger.management.onEnabled.addListener((info)=>{
  if (info.id=='cardbook@vigneau.philippe') {
debug('cardbook enabled');
    pleasereopen();
  }
});
messenger.management.onDisabled.addListener((info)=>{
  if (info.id=='cardbook@vigneau.philippe') {
debug('cardbook disabled');
    pleasereopen();
  }
});
messenger.management.onInstalled.addListener((info)=>{
  if (info.id=='cardbook@vigneau.philippe') {
debug('cardbook installed');
    pleasereopen();
  }
});
messenger.management.onUninstalled.addListener((info)=>{
  //not called on update
  if (info.id=='cardbook@vigneau.philippe') {
debug('cardbook uninstalled');
    pleasereopen();
  }
});

let debugcache='';
function debug(txt) {
	let e = new Error();
	let stack = e.stack.toString().split(/\r\n|\n/);
	let ln=stack[1].replace(/moz-extension:\/\/.*\/(.*:\d+):\d+/, '$1');	//getExternalFilename@file:///D:/sourcen/Mozilla/thunderbird/Extensions/AddressbooksSync_wee/abs_utils.js:1289:6
	if (!ln) ln='?';

	if (prefs) {
		if (prefs.debug) {
			if (debugcache) console.log(debugcache); debugcache='';
			console.log('SMR: '+ln+' '+txt);
		}
	} else {
		debugcache+='SMR: '+ln+' '+txt+'\n';
	}
}
