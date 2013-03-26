/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const { Cc, Ci, Cu, Cr } = require('chrome');
Cu.import('resource://slimerjs/slLauncher.jsm');
Cu.import('resource://slimerjs/slUtils.jsm');
Cu.import('resource://slimerjs/slConfiguration.jsm');
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import('resource://slimerjs/slPhantomJSKeyCode.jsm');
Cu.import('resource://slimerjs/slQTKeyCodeToDOMCode.jsm');

const {validateOptions} = require("sdk/deprecated/api-utils");
const {
    getScreenshotCanvas, setAuthHeaders, removeAuthPrompt,
    getCookies, setCookies, Cookie
} = require("./utils");

const fs = require("sdk/io/file");
const base64 = require("sdk/base64");

const netLog = require('net-log');
netLog.startTracer();

/**
 * create a webpage object
 */
function create() {

    // -----------------------  private properties and functions for the webpage object

    /**
     * the <browser> element loading the webpage content
     */
    var browser = null;

    /**
     * library path
     */
    var libPath = slConfiguration.scriptFile.parent.clone();

    /**
     * utility function to create a sandbox when executing a
     * user script in the webpage content
     */
    function createSandBox() {
        let win = browser.contentWindow;
        let sandbox = Cu.Sandbox(win,
            {
                'sandboxName': browser.currentURI.spec,
                'sandboxPrototype': win,
                'wantXrays': false
            });
        return sandbox;
    }
    var webPageSandbox = null;

    function evalInSandbox (src) {
        if (!webPageSandbox)
            webPageSandbox = createSandBox();
        return Cu.evalInSandbox(src, webPageSandbox);
    }

    /**
     * an observer for the Observer Service.
     * It observes console events.
     */
    var webpageObserver = {
        QueryInterface: XPCOMUtils.generateQI([Ci.nsISupportsWeakReference,Ci.nsIObserver]),

        observe: function webpageobserver_observe(aSubject, aTopic, aData) {
            if (aTopic == "console-api-log-event") {
                if (!webpage.onConsoleMessage)
                    return;
                // aData == outer window id
                // aSubject == console event object. see http://mxr.mozilla.org/mozilla-central/source/dom/base/ConsoleAPI.js#254
                let domWindowUtils = browser.contentWindow
                            .QueryInterface(Ci.nsIInterfaceRequestor)
                            .getInterface(Ci.nsIDOMWindowUtils);
                var consoleEvent = aSubject.wrappedJSObject;
                if (domWindowUtils.outerWindowID == aData) {
                    webpage.onConsoleMessage(consoleEvent.arguments[0], consoleEvent.lineNumber, consoleEvent.filename);
                    return
                }
                // probably the window is an iframe of the webpage. check if this is
                // the case
                let iframe = domWindowUtils.getOuterWindowWithId(aData);
                if (iframe) {
                    let dwu = iframe.top.QueryInterface(Ci.nsIInterfaceRequestor)
                            .getInterface(Ci.nsIDOMWindowUtils);
                    if (dwu.outerWindowID == domWindowUtils.outerWindowID) {
                        webpage.onConsoleMessage(consoleEvent.arguments[0], consoleEvent.lineNumber, consoleEvent.filename);
                        return;
                    }
                }
                return;
            }
        }
    }

    /**
     * build an object of options for the netlogger
     */
    function getNetLoggerOptions(webpage, url, callback) {
        return options = {
            onRequest: function(request) {webpage.resourceRequested(request);},
            onResponse:  function(res) {webpage.resourceReceived(res);},
            captureTypes: webpage.captureContent,
            onLoadStarted: function(){ webpage.loadStarted(); },
            onURLChanged: function(url){ webpage.urlChanged(url);},
            onTransferStarted :null,
            onContentLoaded: function(success){
                // phantomjs call onInitialized not only at the page creation
                // but also after the content loading.. don't know why.
                // let's imitate it. Only after a success
                if (success)
                    webpage.initialized();
                else {
                    // in case of a network fail, phantomjs send
                    // a resourceReceived event.
                    webpage.resourceReceived({
                        id: 0,
                        url: url,
                        time: new Date(),
                        headers: {},
                        bodySize: 0,
                        contentType: null,
                        contentCharset: null,
                        redirectURL: null,
                        stage: "end",
                        status: null,
                        statusText: null,
                        referrer: "",
                        body: ""
                    });
                }
            },
            onLoadFinished: function(success){
                webpage.loadFinished(success);
                if (callback) {
                    callback(success);
                    callback = null;
                }
            }
        }
    }

    /**
     * some private parameters
     */
     var privateParameters = {
         clipRect : null
     }

    // ----------------------------------- webpage

    /**
     * the webpage object itself
     */
    var webpage = {

        settings : null,

        /**
         * list of regexp matching content types
         * of resources for which you want to retrieve the content.
         * The content is then set on the body property of the response
         * object received by your onResourceReceived callback
         */
        captureContent : [],

        // ------------------------ cookies and headers
        get cookies() {
            throw "Not Implemented"
        },

        set cookies(val) {
            throw "Not Implemented"
        },

        get customHeaders() {
            throw "Not Implemented"
        },

        set customHeaders(val) {
            throw "Not Implemented"
        },

        addCookie: function(cookie) {
            throw "Not Implemented"
        },

        clearCookies: function() {
            throw "Not Implemented"
        },

        deleteCookie: function(cookieName) {
            throw "Not Implemented"
        },

        // -------------------------------- History

        get canGoBack () {
            return browser.canGoBack;
        },

        get canGoForward () {
            return browser.canGoForward;
        },

        go : function(indexIncrement) {
            let h = browser.sessionHistory;
            let index = h.index + indexIncrement;
            if (index >= h.count || index < 0)
                return;
            browser.gotoIndex(index);
        },

        goBack : function() {
            browser.goBack();
        },

        goForward : function() {
            browser.goForward();
        },

        get navigationLocked() {
            throw "Not Implemented"
        },

        set navigationLocked(val) {
            throw "Not Implemented"
        },

        reload : function() {
            browser.reload();
        },

        stop : function() {
            browser.stop();
        },

        // -------------------------------- Window manipulation

        /**
         * Open a web page in a browser
         * @param string url    the url of the page to open
         * @param function callback  a function called when the page is loaded. it
         *                           receives "success" or "fail" as parameter.
         */
        open: function(url, callback) {

            var me = this;
            var options = getNetLoggerOptions(this, url, callback);
            if (browser) {
                // don't recreate a browser if already opened.
                netLog.registerBrowser(browser, options);
                browser.loadURI(url);
                return;
            }

            slLauncher.openBrowser(function(nav){
                browser = nav;
                browser.parentNode.webpage = me;
                Services.obs.addObserver(webpageObserver, "console-api-log-event", true);
                netLog.registerBrowser(browser, options);
                me.initialized();
                browser.loadURI(url);
            });
        },

        openUrl: function(url, httpConf, settings) {
            throw "Not Implemented"
        },

        /**
         * close the browser
         */
        close: function() {
            if (browser) {
                Services.obs.removeObserver(webpageObserver, "console-api-log-event");
                netLog.unregisterBrowser(browser);
                if (this.onClosing)
                    this.onClosing(this);
                browser.webpage = null;
                slLauncher.closeBrowser(browser);
            }
            webPageSandbox = null;
            browsers=null;
        },

        /**
         * function called when the browser is being closed, during a call of WebPage.close()
         * or during a call of window.close() inside the web page (not implemented yet)
         */
        onClosing: null,

        childFramesCount: function () {
            throw "Not Implemented"
        },

        childFramesName : function () {
            throw "Not Implemented"
        },

        currentFrameName : function () {
            throw "Not Implemented"
        },

        get frameUrl() {
            throw "Not Implemented"
        },

        get focusedFrameName () {
            throw "Not Implemented"
        },

        get frameCount () {
            throw "Not Implemented"
        },

        get framesName () {
            throw "Not Implemented"
        },

        get ownsPages () {
            throw "Not Implemented"
        },

        getPage: function (windowName) {
            throw "Not Implemented"
        },

        get pages () {
            throw "Not Implemented"
        },

        get pagesWindowName () {
            throw "Not Implemented"
        },

        release : function() {
            throw "Not Implemented"
        },

        get scrollPosition() {
            throw "Not Implemented"
        },

        set scrollPosition(val) {
            throw "Not Implemented"
        },

        switchToFocusedFrame: function() {
            throw "Not Implemented"
        },

        switchToFrame: function(frame) {
            throw "Not Implemented"
        },

        switchToChildFrame: function(frame) {
            throw "Not Implemented"
        },

        switchToMainFrame: function() {
            throw "Not Implemented"
        },

        switchToParentFrame: function() {
            throw "Not Implemented"
        },

        get url() {
            if (browser)
                return browser.currentURI.spec;
            return "";
        },

        get viewportSize() {
            if (!browser)
                return {width:0, height:0};
            let win = browser.parentNode.ownerDocument.defaultView.top;
            return {
                width: win.innerWidth,
                height: win.innerHeight
            }
        },

        set viewportSize(val) {
            if (!browser)
                return;
            let win = browser.parentNode.ownerDocument.defaultView.top;

            if (typeof val != "object")
                throw new Error("Bad argument type");

            let w = val.width || 0;
            let h = val.height || 0;

            if (w <= 0 || h <= 0)
                return;

            let domWindowUtils = win.QueryInterface(Ci.nsIInterfaceRequestor)
                                    .getInterface(Ci.nsIDOMWindowUtils);
            domWindowUtils. setCSSViewport(w,h);
        },


        get windowName () {
            throw "Not Implemented"
        },

        // -------------------------------- Javascript evaluation

        /**
         * FIXME: modifying a variable in a sandbox
         * that inherits of the context of a window,
         * does not propagate the modification into
         * this context. We have same
         * issue that https://bugzilla.mozilla.org/show_bug.cgi?id=783499
         * the only solution is to do window.myvariable = something in the
         * given function, instead of myvariable = something 
         */
        evaluate: function(func) {
            if (!browser)
                throw "WebPage not opened";
            let args = JSON.stringify(Array.prototype.slice.call(arguments).slice(1));
            func = '('+func.toSource()+').apply(this, ' + args + ');';
            return evalInSandbox(func);
        },

        evaluateJavascript: function(src) {
            return evalInSandbox(src);
        },

        evaluateAsync: function(func) {
            if (!browser)
                throw "WebPage not opened";
            func = '('+func.toSource()+')();';
            browser.contentWindow.setTimeout(function() {
                evalInSandbox(func);
            }, 0)
        },

        includeJs: function(url, callback) {
            if (!browser)
                throw "WebPage not opened";
            // we don't use the sandbox, because with it, scripts
            // of the loaded page cannot access to variables/functions
            // created by the injected script. And this behavior
            // is necessary to be compatible with phantomjs.
            let doc = browser.contentWindow.document;
            let body = doc.documentElement.getElementsByTagName("body")[0];
            let script = doc.createElement('script');
            script.setAttribute('type', 'text/javascript');
            script.setAttribute('src', url);
            let listener = function(event){
                script.removeEventListener('load', listener, true);
                callback();
            }
            script.addEventListener('load', listener, true);
            body.appendChild(script);
        },

        get libraryPath () {
            return libPath.path;
        },

        set libraryPath (path) {
            libPath = Cc['@mozilla.org/file/local;1']
                            .createInstance(Ci.nsILocalFile);
            libPath.initWithPath(path);
        },

        /**
         * FIXME: modifying a variable in a sandbox
         * that inherits of the context of a window,
         * does not propagate the modification into
         * this context. We have same
         * issue that https://bugzilla.mozilla.org/show_bug.cgi?id=783499
         * the only solution is to do window.myvariable = something in the
         * given function, instead of myvariable = something 
         */
        injectJs: function(filename) {
            if (!browser) {
                throw "WebPage not opened";
            }
            // filename resolved against the libraryPath property
            let f = getMozFile(filename, libPath);
            let source = readSyncStringFromFile(f);
            evalInSandbox(source);
        },
        get onError() {
            throw "Not Implemented"
        },
        set onError(callback) {
            throw "Not Implemented"
        },

        // --------------------------------- content manipulation

        get content () {
            if (!browser)
                throw "WebPage not opened";

            const de = Ci.nsIDocumentEncoder
            let encoder = Cc["@mozilla.org/layout/documentEncoder;1?type=text/html"]
                            .createInstance(Ci.nsIDocumentEncoder);
            let doc = browser.contentDocument;
            encoder.init(doc, "text/html", de.OutputLFLineBreak | de.OutputRaw);
            encoder.setNode(doc);
            return encoder.encodeToString();
        },

        set content(val) {
            throw "Not Implemented"
        },

        get frameContent() {
            throw "Not Implemented"
        },

        set frameContent(val) {
            throw "Not Implemented"
        },

        get framePlainText() {
            throw "Not Implemented"
        },

        get frameTitle() {
            throw "Not Implemented"
        },

        get offlineStoragePath() {
            throw "Not Implemented"
        },

        set offlineStoragePath(val) {
            throw "Not Implemented"
        },

        get offlineStorageQuota() {
            throw "Not Implemented"
        },

        set offlineStorageQuota(val) {
            throw "Not Implemented"
        },


        get plainText() {
            if (!browser)
                throw "WebPage not opened";

            const de = Ci.nsIDocumentEncoder
            let encoder = Cc["@mozilla.org/layout/documentEncoder;1?type=text/plain"]
                            .createInstance(Ci.nsIDocumentEncoder);
            let doc = browser.contentDocument;
            encoder.init(doc, "text/plain", de.OutputLFLineBreak | de.OutputBodyOnly);
            encoder.setNode(doc);
            return encoder.encodeToString();
        },

        sendEvent: function(eventType, arg1, arg2, button, modifier) {
            if (!browser)
                throw new Error("WebPage not opened");

            eventType = eventType.toLowerCase();
            browser.contentWindow.focus();
            let domWindowUtils = browser.contentWindow
                                        .QueryInterface(Ci.nsIInterfaceRequestor)
                                        .getInterface(Ci.nsIDOMWindowUtils);
            if (modifier) {
                let  m = 0;
                let mod = this.event.modifiers;
                if (modifier & mod.shift) m |= domWindowUtils.MODIFIER_SHIFT;
                if (modifier & mod.alt) m |= domWindowUtils.MODIFIER_ALT;
                if (modifier & mod.ctrl) m |= domWindowUtils.MODIFIER_CONTROL;
                if (modifier & mod.meta) m |= domWindowUtils.MODIFIER_META;
                modifier = m;
            }
            else
                modifier = 0;

            if (eventType == 'keydown' || eventType == 'keyup') {
                var keyCode = arg1;
                if ((typeof keyCode) != "number") {
                    if (keyCode.length == 0)
                        return;
                    keyCode = keyCode.charCodeAt(0);
                }

                let DOMKeyCode = convertQTKeyCode(keyCode);
                if (DOMKeyCode.modifier && modifier == 0)
                    modifier = DOMKeyCode.modifier;

                domWindowUtils.sendKeyEvent(eventType, DOMKeyCode.keyCode, DOMKeyCode.charCode, modifier);
                return;
            }
            else if (eventType == 'keypress') {
                let key = arg1;
                if (typeof key == "number") {
                    let DOMKeyCode = convertQTKeyCode(key);
                    domWindowUtils.sendKeyEvent("keypress", DOMKeyCode.keyCode, DOMKeyCode.charCode, modifier);
                }
                else if (key.length == 1) {
                    let charCode = key.charCodeAt(0);
                    let DOMKeyCode = convertQTKeyCode(charCode);
                    domWindowUtils.sendKeyEvent("keypress", DOMKeyCode.keyCode, charCode, modifier);
                }
                else {
                    for(let i=0; i < key.length;i++) {
                        let charCode = key.charCodeAt(i);
                        let DOMKeyCode = convertQTKeyCode(charCode);
                        domWindowUtils.sendKeyEvent("keydown", DOMKeyCode.keyCode, DOMKeyCode.charCode, modifier);
                        domWindowUtils.sendKeyEvent("keypress", DOMKeyCode.keyCode, charCode, modifier);
                        domWindowUtils.sendKeyEvent("keyup", DOMKeyCode.keyCode, DOMKeyCode.charCode, modifier);
                    }
                }
                return;
            }

            let btn = 0;
            if (button == 'middle')
                btn = 1;
            else if (button == 'right')
                btn = 2;

            let x = arg1 || 0;
            let y = arg2 || 0;

            // mouse events
            if (eventType == "mousedown" ||
                eventType == "mouseup" ||
                eventType == "mousemove") {

                domWindowUtils.sendMouseEvent(eventType,
                        x, y, btn, 1, modifier);
                return;
            }
            else if (eventType == "mousedoubleclick") {
                // this type allowed by phantomjs has no really equivalence
                // and tests in phantomjs show that it is simply... buggy
                // note that is undocumented (2013-02-22)
                domWindowUtils.sendMouseEvent("mousedown",
                        x, y, btn, 2, modifier);
                return;
            }
            else if (eventType == "doubleclick") {
                domWindowUtils.sendMouseEvent("mousedown",
                        x, y, btn, 1, modifier);
                domWindowUtils.sendMouseEvent("mouseup",
                        x, y, btn, 1, modifier);
                domWindowUtils.sendMouseEvent("mousedown",
                        x, y, btn, 2, modifier);
                domWindowUtils.sendMouseEvent("mouseup",
                        x, y, btn, 2, modifier);
                return;
            }
            else if (eventType == "click") {
                domWindowUtils.sendMouseEventToWindow("mousedown",
                        x, y, btn, 1, modifier);
                domWindowUtils.sendMouseEventToWindow("mouseup",
                        x, y, btn, 1, modifier);
                return;
            }

            throw "Unknown event type";
        },

        event : {
            modifiers : {
                shift:  0x02000000,
                ctrl:   0x04000000,
                alt:    0x08000000,
                meta:   0x10000000,
                keypad: 0x20000000
            },
            key : phantomJSKeyCodeList.key // unicode values
        },

        get title() {
            if (!browser) {
                return '';
            }
            return browser.contentDocument.title;
        },

        setContent: function(content, url) {
            throw "Not Implemented"
        },

        uploadFile: function(selector, filename) {
            throw "Not Implemented"
        },

        // ------------------------------- Screenshot and pdf export

        /**
         * clipRect defines the rectangle to render from the webpage
         * when calling render*() methods
         */
        get clipRect () {
            return privateParameters.clipRect;
        },
        set clipRect (value) {
            let requirements = {
                top: {
                    is: ["number"],
                    ok: function(val) val >= 0,
                    msg: "top should be a positive integer"
                },
                left: {
                    is: ["number"],
                    ok: function(val) val >= 0,
                    msg: "left should be a positive integer"
                },
                width: {
                    is: ["number"],
                    ok: function(val) val > 0,
                    msg: "width should be a positive integer"
                },
                height: {
                    is: ["number"],
                    ok: function(val) val > 0,
                    msg: "height should be a positive integer"
                },
            }
            if (typeof(value) === "object") {
                privateParameters.clipRect = validateOptions(value, requirements);
            } else {
                privateParameters.clipRect = null;
            }
        },
        paperSize : null,
        zoomFactor : null,

        render: function(filename, ratio) {
            if (!browser)
                throw "WebPage not opened";
            let format = fs.extension(filename).toLowerCase() || 'png';
            let content = this.renderBytes(format, ratio);
            fs.write(filename, content, "wb");
        },

        renderBytes: function(format, ratio) {
            return base64.decode(this.renderBase64(format, ratio));
        },

        renderBase64: function(format, ratio) {
            if (!browser)
                throw "WebPage not opened";

            format = (format || "png").toString().toLowerCase();
            let qual = undefined;
            if (format == "png") {
                format = "image/png";
            } else if (format == "jpeg") {
                format = "image/jpeg";
                qual = 0.8;
            } else {
                throw new Error("Render format \"" + format + "\" is not supported");
            }

            let canvas = getScreenshotCanvas(browser.contentWindow,
                                             privateParameters.clipRect, ratio);

            return canvas.toDataURL(format, qual).split(",", 2)[1];
        },

        //--------------------------------------------------- window popup callback

        onAlert : null,

        get onCallback() {
            throw "Not Implemented"
        },

        set onCallback(callback) {
            throw "Not Implemented"
        },

        onConfirm : null,

        onConsoleMessage : null,

        get onFilePicker() {
            throw "Not Implemented"
        },

        set onFilePicker(callback) {
            throw "Not Implemented"
        },

        onPrompt : null,

        // ------------------------------ browsing callbacks

        // This callback is invoked after the web page is created but before a URL is loaded. The callback may be used to change global objects (document...)
        onInitialized: null,

        //This callback is invoked when the page finishes the loading. It may accept a single argument indicating the page's status: 'success' if no network errors occurred, otherwise 'fail'.
        onLoadFinished: null,

        //This callback is invoked when the page starts the loading. There is no argument passed to the callback.
        onLoadStarted: null,

        get onNavigationRequested() {
            throw "Not Implemented"
        },

        set onNavigationRequested(callback) {
            throw "Not Implemented"
        },

        // This callback is invoked when a new child window (but not deeper descendant windows) is created by the page, e.g. using window.open
        get onPageCreated() {
            throw "Not Implemented"
        },

        set onPageCreated(callback) {
            throw "Not Implemented"
        },

        onResourceRequested : null,

        onResourceReceived : null,

        //This callback is invoked when the URL changes, e.g. as it navigates away from the current URL.
        onUrlChanged : null,

        // -------------------------------- private methods to send some events
        closing:function (page) {
            throw "Not Implemented"
        },

        initialized: function() {
            webPageSandbox = null;
            if (this.onInitialized)
                this.onInitialized();
        },

        javaScriptAlertSent: function(message) {
            if (this.onAlert)
                this.onAlert(message);
        },

        javaScriptConsoleMessageSent: function(message, lineNumber, fileName) {
            if (this.onConsoleMessage)
                onConsoleMessage(message, lineNumber, fileName);
        },

        loadFinished: function(status) {
            webPageSandbox = null;
            if (this.onLoadFinished)
                this.onLoadFinished(status);
        },

        loadStarted: function() {
            webPageSandbox = null;
            if (this.onLoadStarted)
                this.onLoadStarted();
        },

        navigationRequested: function(url, navigationType, navigationLocked, isMainFrame) {
            throw "Not Implemented"
        },

        rawPageCreated: function(page) {
            throw "Not Implemented"
        },

        resourceReceived: function(request) {
            if (this.onResourceReceived)
                this.onResourceReceived(request);
        },

        resourceRequested: function(resource) {
            if (this.onResourceRequested)
                this.onResourceRequested(resource);
        },

        urlChanged: function(url) {
            webPageSandbox = null;
            if (this.onUrlChanged)
                this.onUrlChanged(url);
        }
    };

    return webpage;
}
exports.create = create;

/*
function WebPage() {
    this.prototype = create();
}
*/