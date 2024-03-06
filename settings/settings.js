let prefs = {};

async function saveSettings() {
    let sentTypes = ["To", "Cc", "Bcc"];
    sentTypes.forEach(item => {
        prefs.SonnResentDefaultAddr[item] = document.querySelector("#Resent" + CSS.escape(item) + "Input").value;
    });
    await messenger.storage.local.set(prefs);
}

function validate(ev) {
    const re = /^(\s?[^\s,]+@[^\s,]+\s?,)*(\s?[^\s,]+@[^\s,]+)$/i;
    let address = ev.target.value;
    // console.log("validate elem", address);
    if (!address) {
        ev.target.className = 'address valid';
    }
    else if (re.test(address)) {
        ev.target.className = 'address valid';
    } else {
        ev.target.className = 'address invalid';
    }

    let i = document.getElementsByClassName('address invalid').length;
    let v = document.getElementsByClassName('address valid').length;
    if (i || !v) {
        document.getElementById('addressOK').disabled = true;
    } else {
        document.getElementById('addressOK').disabled = false;
    }
}

async function load() {
    prefs = await messenger.storage.local.get({
        SonnResentDefaultAddr: [],
    });
    console.log("settings: ", prefs);
    document.getElementById("addressOK").addEventListener('click', saveSettings);

    let sentTypes = ["To", "Cc", "Bcc"];
    sentTypes.forEach(item => {
        let addressInput = document.querySelector("#Resent" + CSS.escape(item) + "Input");
        let prefSetting = prefs.SonnResentDefaultAddr[item];
        addressInput.value = "";
        if (prefSetting) {
            addressInput.value = prefs.SonnResentDefaultAddr[item];
        }

        addressInput.addEventListener("input", validate);
    });
//    console.log("test changefrom: ", Object.values(prefs.SonnResentDefaultAddr));
}


document.addEventListener('DOMContentLoaded', load, {once: true});
