/** @license Hyphenopoly 1.0.1 - client side hyphenation for webbrowsers
 *  ©2018  Mathias Nater, Zürich (mathiasnater at gmail dot com)
 *  https://github.com/mnater/Hyphenopoly
 *
 *  Released under the MIT license
 *  http://mnater.github.io/Hyphenopoly/LICENSE
 */

;/*jslint browser, bitwise*/
/*global window, Hyphenopoly, TextDecoder, WebAssembly, asmHyphenEngine*/
(function mainWrapper(w) {
    "use strict";
    const H = Hyphenopoly;
    const SOFTHYPHEN = String.fromCharCode(173);

    function empty() {
        return Object.create(null);
    }

    Math.imul = Math.imul || function(a, b) {
        var aHi = (a >>> 16) & 0xffff;
        var aLo = a & 0xffff;
        var bHi = (b >>> 16) & 0xffff;
        var bLo = b & 0xffff;
        // the shift by 0 fixes the sign on the high part
        // the final |0 converts the unsigned value into a signed value
        return ((aLo * bLo) + (((aHi * bLo + aLo * bHi) << 16) >>> 0) | 0);
    };

    function setProp(val, props) {
        /* props is a bit pattern:
         * 1. bit: configurable
         * 2. bit: enumerable
         * 3. bit writable
         * e.g. 011(2) = 3(10) => configurable: false, enumerable: true, writable: true
         * or   010(2) = 2(10) => configurable: false, enumerable: true, writable: false
         */
        return {
            configurable: (props & 4) > 0,
            enumerable: (props & 2) > 0,
            writable: (props & 1) > 0,
            value: val
        };
    }

    (function configurationFactory() {
        const generalDefaults = Object.create(null, {
            timeout: setProp(1000, 2),
            defaultLanguage: setProp("en-us", 2),
            dontHyphenateClass: setProp("donthyphenate", 2),
            dontHyphenate: setProp((function () {
                const r = empty();
                const list = "video,audio,script,code,pre,img,br,samp,kbd,var,abbr,acronym,sub,sup,button,option,label,textarea,input,math,svg,style";
                list.split(",").forEach(function (value) {
                    r[value] = true;
                });
                return r;
            }()), 2),
            safeCopy: setProp(true, 2),
            normalize: setProp(false, 2),
            exceptions: setProp(empty(), 2)
        });

        const settings = Object.create(generalDefaults);

        const perClassDefaults = Object.create(null, {
            minWordLength: setProp(6, 2),
            leftmin: setProp(0, 2),
            leftminPerLang: setProp(0, 2),
            rightmin: setProp(0, 2),
            rightminPerLang: setProp(0, 2),
            hyphen: setProp(SOFTHYPHEN, 2), //soft hyphen
            orphanControl: setProp(1, 2),
            compound: setProp("hyphen", 2)
        });

        //copy settings if not yet set
        Object.keys(H.setup).forEach(function (key) {
            if (key === "classnames") {
                const classNames = Object.keys(H.setup.classnames);
                Object.defineProperty(settings, "classNames", setProp(classNames, 2));
                classNames.forEach(function (cn) {
                    const tmp = {};
                    Object.keys(H.setup.classnames[cn]).forEach(function (pcnkey) {
                        tmp[pcnkey] = setProp(H.setup.classnames[cn][pcnkey], 2);
                    });
                    Object.defineProperty(settings, cn, setProp(Object.create(perClassDefaults, tmp), 2));
                });
            } else {
                Object.defineProperty(settings, key, setProp(H.setup[key], 3));
            }
        });
        H.c = settings;
    }());

    (function H9Y(w) {
        const C = H.c;

        let mainLanguage = null;

        let elements;
        function makeElementCollection() {
            //counter counts the elements to be hyphenated. Needs to be an object (Pass by reference)
            let counter = [0];

            const list = empty();

            function makeElement(element, cn) {
                return {
                    element: element,
                    class: cn
                };
            }

            function add(el, lang, cn) {
                const elo = makeElement(el, cn);
                if (list[lang] === undefined) {
                    list[lang] = [];
                }
                list[lang].push(elo);
                counter[0] += 1;
                return elo;
            }

            function each(fn) {
                Object.keys(list).forEach(function (k) {
                    fn(k, list[k]);
                });
            }

            return {
                counter: counter,
                list: list,
                add: add,
                each: each
            };
        }

        const registerOnCopy = function (el) {
            el.addEventListener("copy", function (e) {
                e.preventDefault();
                const selectedText = window.getSelection().toString();
                e.clipboardData.setData("text/plain", selectedText.replace(new RegExp(SOFTHYPHEN, "g"), ""));
            }, true);
        };

        function getLang(el, fallback) {
            try {
                return (el.getAttribute("lang"))
                    ? el.getAttribute("lang").toLowerCase()
                    : el.tagName.toLowerCase() !== "html"
                        ? getLang(el.parentNode, fallback)
                        : fallback
                            ? mainLanguage
                            : null;
            } catch (ignore) {}
        }

        function autoSetMainLanguage() {
            const el = w.document.getElementsByTagName("html")[0];

            mainLanguage = getLang(el, false);
            //fallback to defaultLang if set
            if (!mainLanguage && C.defaultLanguage !== "") {
                mainLanguage = C.defaultLanguage;
            }
            //el.lang = mainLanguage; //this trigger recalculate style! is it really necessary?
        }

        function sortOutSubclasses(x, y) {
            return (x[0] === "")
                ? []
                : x.filter(function (i) {
                    return y.indexOf(i) !== -1;
                });
        }

        function collectElements() {
            elements = makeElementCollection();
            function processText(el, pLang, cn, isChild) {
                let eLang;
                let n;
                let j = 0;
                isChild = isChild || false;
                //set eLang to the lang of the element
                if (el.lang && typeof el.lang === "string") {
                    eLang = el.lang.toLowerCase(); //copy attribute-lang to internal eLang
                } else if (pLang !== undefined && pLang !== "") {
                    eLang = pLang.toLowerCase();
                } else {
                    eLang = getLang(el, true);
                }
                if (H.testResults.languages[eLang] === "H9Y") {
                    elements.add(el, eLang, cn);
                    if (!isChild && C.safeCopy) {
                        registerOnCopy(el);
                    }
                }

                n = el.childNodes[j];
                while (n !== undefined) {
                    if (n.nodeType === 1 && !C.dontHyphenate[n.nodeName.toLowerCase()] && n.className.indexOf(C.dontHyphenateClass) === -1) {
                        if (sortOutSubclasses(n.className.split(" "), C.classNames).length === 0) {
                            //this child element doesn't contain a hyphenopoly-class
                            processText(n, eLang, cn, true);
                        }
                    }
                    j += 1;
                    n = el.childNodes[j];
                }
            }
            C.classNames.forEach(function (cn) {
                const nl = w.document.querySelectorAll("." + cn);
                Array.prototype.forEach.call(nl, function (n) {
                    processText(n, getLang(n, true), cn, false);
                });
            });
            H.elementsReady = true;
        }

        const wordHyphenatorPool = empty();

        function createWordHyphenator(lo, lang, cn) {
            const classSettings = C[cn];
            const normalize = C.normalize && (String.prototype.normalize !== undefined);
            const hyphen = classSettings.hyphen;

            lo.cache[cn] = empty();
            function hyphenateCompound(lo, lang, word) {
                const zeroWidthSpace = String.fromCharCode(8203);
                let parts;
                let i = 0;
                let wordHyphenator;
                let hw = word;
                switch (classSettings.compound) {
                case "auto":
                    parts = word.split("-");
                    wordHyphenator = createWordHyphenator(lo, lang, cn);
                    while (i < parts.length) {
                        if (parts[i].length >= classSettings.minWordLength) {
                            parts[i] = wordHyphenator(parts[i]);
                        }
                        i += 1;
                    }
                    hw = parts.join("-");
                    break;
                case "all":
                    parts = word.split("-");
                    wordHyphenator = createWordHyphenator(lo, lang, cn);
                    while (i < parts.length) {
                        if (parts[i].length >= classSettings.minWordLength) {
                            parts[i] = wordHyphenator(parts[i]);
                        }
                        i += 1;
                    }
                    hw = parts.join("-" + zeroWidthSpace);
                    break;
                default: //"hyphen" and others
                    hw = word.replace("-", "-" + zeroWidthSpace);
                }
                return hw;
            }

            function hyphenator(word) {
                if (normalize) {
                    word = word.normalize("NFC");
                }
                let hw = lo.cache[cn][word];
                if (!hw) {
                    if (lo.exceptions[word] !== undefined) { //the word is in the exceptions list
                        hw = lo.exceptions[word].replace(/-/g, classSettings.hyphen);
                    } else if (word.indexOf("-") !== -1) {
                        hw = hyphenateCompound(lo, lang, word);
                    } else {
                        hw = lo.hyphenateFunction(word, hyphen, classSettings.leftminPerLang[lang], classSettings.rightminPerLang[lang]);
                    }
                    lo.cache[cn][word] = hw;
                }
                return hw;
            }
            wordHyphenatorPool[lang + "-" + cn] = hyphenator;
            return hyphenator;
        }

        const orphanControllerPool = empty();

        function createOrphanController(cn) {
            function controlOrphans(ignore, leadingWhiteSpace, lastWord, trailingWhiteSpace) {
                const classSettings = C[cn];
                let h = classSettings.hyphen;
                //escape hyphen
                if (".\\+*?[^]$(){}=!<>|:-".indexOf(classSettings.hyphen) !== -1) {
                    h = "\\" + classSettings.hyphen;
                }
                if (classSettings.orphanControl === 3 && leadingWhiteSpace === " ") {
                    leadingWhiteSpace = String.fromCharCode(160);
                }
                return leadingWhiteSpace + lastWord.replace(new RegExp(h, "g"), "") + trailingWhiteSpace;
            }
            orphanControllerPool[cn] = controlOrphans;
            return controlOrphans;
        }

        function hyphenateElement(lang, elo) {
            const el = elo.element;
            const lo = H.languages[lang];
            const cn = elo.class;
            const classSettings = C[cn];
            const minWordLength = classSettings.minWordLength;
            H.events.dispatch("beforeElementHyphenation", {el: el, lang: lang});
            const wordHyphenator = (wordHyphenatorPool[lang + "-" + cn] !== undefined)
                ? wordHyphenatorPool[lang + "-" + cn]
                : createWordHyphenator(lo, lang, cn);
            const orphanController = (orphanControllerPool[cn] !== undefined)
                ? orphanControllerPool[cn]
                : createOrphanController(cn);
            const re = lo.genRegExps[cn];
            let i = 0;
            let n = el.childNodes[i];
            while (n) {
                if (
                    n.nodeType === 3 //type 3 = #text
                        && n.data.length >= minWordLength //longer then min
                ) {
                    let tn = n.data.replace(re, wordHyphenator);
                    if (classSettings.orphanControl !== 1) {
                        //prevent last word from being hyphenated
                        tn = tn.replace(/(\u0020*)(\S+)(\s*)$/, orphanController);
                    }
                    n.data = tn;
                }
                i += 1;
                n = el.childNodes[i];
            }
            elements.counter[0] -= 1;
            H.events.dispatch("afterElementHyphenation", {el: el, lang: lang});
        }

        function hyphenateLangElements(lang, elArr) {
            if (elArr !== undefined) {
                elArr.forEach(function eachElem(elo) {
                    hyphenateElement(lang, elo);
                });
            } else {
                H.events.dispatch("error", {msg: "engine for language '" + lang + "' loaded, but no elements found."});
            }
            if (elements.counter[0] === 0) {
                H.events.dispatch("hyphenopolyEnd");
            }

        }

        function convertExceptionsToObject(exc) {
            const words = exc.split(", ");
            const r = empty();
            const l = words.length;
            let i = 0;
            let key;
            while (i < l) {
                key = words[i].replace(/-/g, "");
                if (r[key] === undefined) {
                    r[key] = words[i];
                }
                i += 1;
            }
            return r;
        }

        function prepareLanguagesObj(lang, hyphenateFunction, alphabet, leftmin, rightmin) {
            alphabet = alphabet.replace(/-/g, "");
            if (!H.hasOwnProperty("languages")) {
                H.languages = {};
            }
            if (!H.languages.hasOwnProperty(lang)) {
                H.languages[lang] = empty();
            }
            const lo = H.languages[lang];
            if (!lo.engineReady) {
                lo.cache = empty();
                //copy global exceptions to the language specific exceptions
                if (H.c.exceptions.global !== undefined) {
                    if (H.c.exceptions[lang] !== undefined) {
                        H.c.exceptions[lang] += ", " + H.c.exceptions.global;
                    } else {
                        H.c.exceptions[lang] = H.c.exceptions.global;
                    }
                }
                //move exceptions from the the local "exceptions"-obj to the "language"-object
                if (H.c.exceptions[lang] !== undefined) {
                    lo.exceptions = convertExceptionsToObject(H.c.exceptions[lang]);
                    delete H.c.exceptions[lang];
                } else {
                    lo.exceptions = empty();
                }
                lo.genRegExps = empty();
                lo.leftmin = leftmin;
                lo.rightmin = rightmin;
                lo.hyphenateFunction = hyphenateFunction;
                C.classNames.forEach(function (cn) {
                    const classSettings = C[cn];
                    //merge leftmin/rightmin to config
                    if (classSettings.leftminPerLang === 0) {
                        Object.defineProperty(classSettings, "leftminPerLang", setProp(empty(), 2));
                    }
                    if (classSettings.rightminPerLang === 0) {
                        Object.defineProperty(classSettings, "rightminPerLang", setProp(empty(), 2));
                    }
                    if (classSettings.leftminPerLang[lang] === undefined) {
                        classSettings.leftminPerLang[lang] = Math.max(lo.leftmin, classSettings.leftmin);
                    } else {
                        classSettings.leftminPerLang[lang] = Math.max(lo.leftmin, classSettings.leftmin, classSettings.leftminPerLang[lang]);
                    }
                    if (classSettings.rightminPerLang[lang] === undefined) {
                        classSettings.rightminPerLang[lang] = Math.max(lo.rightmin, classSettings.rightmin);
                    } else {
                        classSettings.rightminPerLang[lang] = Math.max(lo.rightmin, classSettings.rightmin, classSettings.rightminPerLang[lang]);
                    }
                    lo.genRegExps[cn] = new RegExp("[\\w" + alphabet + String.fromCharCode(8204) + "-]{" + classSettings.minWordLength + ",}", "gi");
                });
                lo.engineReady = true;
            }
            Hyphenopoly.events.dispatch("engineReady", {msg: lang});
        }

        function calculateHeapSize(targetSize) {
            if (H.isWASMsupported) {
                //wasm page size: 65536 = 64 Ki
                return Math.ceil(targetSize / 65536) * 65536;
            } else {
                //http://asmjs.org/spec/latest/#linking-0
                const exp = Math.ceil(Math.log2(targetSize));
                if (exp <= 12) {
                    return 1 << 12;
                }
                if (exp < 24) {
                    return 1 << exp;
                }
                return Math.ceil(targetSize / (1 << 24)) * (1 << 24);
            }
        }

        const decode = (function makeDecoder() {
            let decoder;
            if (window.TextDecoder !== undefined) {
                const utf16ledecoder = new TextDecoder("utf-16le");
                decoder = function (ui16) {
                    return utf16ledecoder.decode(ui16);
                };
            } else {
                decoder = function (ui16) {
                    let i = 0;
                    let str = "";
                    while (i < ui16.length) {
                        str += String.fromCharCode(ui16[i]);
                        i += 1;
                    }
                    return str;
                };
            }
            return decoder;
        }());

        function calculateBaseData(hpbBuf) {
            /* Build Heap (the heap object's byteLength must be either 2^n for n in [12, 24) or 2^24 · n for n ≥ 1;)
             * NEW MEMORY LAYOUT:
             *
             * -------------------- <- Offset 0
             * |   translateMap   |
             * |        keys:     |
             * |256 chars * 2Bytes|
             * |         +        |
             * |      values:     |
             * |256 chars * 1Byte |
             * -------------------- <- 768 Bytes
             * |     alphabet     |
             * |256 chars * 2Bytes|
             * -------------------- <- valueStoreOffset = 1280
             * |    valueStore    |
             * |      1 Byte      |
             * |* valueStoreLength|
             * --------------------
             * | align to 4Bytes  |
             * -------------------- <- patternTrieOffset
             * |    patternTrie   |
             * |     4 Bytes      |
             * |*patternTrieLength|
             * -------------------- <- wordOffset
             * |    wordStore     |
             * |    Uint16[64]    | 128 bytes
             * -------------------- <- translatedWordOffset
             * | transl.WordStore |
             * |    Uint16[64]     | 128 bytes
             * -------------------- <- hyphenPointsOffset
             * |   hyphenPoints   |
             * |    Uint8[64]     | 64 bytes
             * -------------------- <- hyphenatedWordOffset
             * |  hyphenatedWord  |
             * |   Uint16[128]    | 256 Bytes
             * -------------------- <- hpbOffset           -
             * |     HEADER       |                        |
             * |    6*4 Bytes     |                        |
             * |    24 Bytes      |                        |
             * --------------------                        |
             * |    PATTERN LIC   |                        |
             * |  variable Length |                        |
             * --------------------                        |
             * | align to 4Bytes  |                        } this is the .hpb-file
             * -------------------- <- hpbTranslateOffset  |
             * |    TRANSLATE     |                        |
             * | 2 + [0] * 2Bytes |                        |
             * -------------------- <- hpbPatternsOffset   |
             * |     PATTERNS     |                        |
             * |  patternsLength  |                        |
             * -------------------- <- heapEnd             -
             * | align to 4Bytes  |
             * -------------------- <- heapSize
             */

            /*
             * [0]: magic number 0x01627068 (\hpb1, 1 is the version)
             * [1]: TRANSLATE offset (to skip LICENSE)
             * [2]: PATTERNS offset (skip LICENSE + TRANSLATE)
             * [3]: patternlength (bytes)
             * [4]: leftmin
             * [5]: rightmin
             * [6]: Trie Array Size (needed to preallocate memory)
             * [7]: Values Size (needed to preallocate memory)
             */
            const hpbMetaData = new Uint32Array(hpbBuf).subarray(0, 8);
            const valueStoreLength = hpbMetaData[7];
            const valueStoreOffset = 1280;
            const patternTrieOffset = valueStoreOffset + valueStoreLength + (4 - ((valueStoreOffset + valueStoreLength) % 4));
            const wordOffset = patternTrieOffset + (hpbMetaData[6] * 4);
            return {
                valueStoreOffset: valueStoreOffset,
                patternTrieOffset: patternTrieOffset,
                wordOffset: wordOffset,
                translatedWordOffset: wordOffset + 128,
                hyphenPointsOffset: wordOffset + 256,
                hyphenatedWordOffset: wordOffset + 320,
                hpbOffset: wordOffset + 576,
                hpbTranslateOffset: wordOffset + 576 + hpbMetaData[1],
                hpbPatternsOffset: wordOffset + 576 + hpbMetaData[2],
                heapSize: Math.max(calculateHeapSize(wordOffset + 576 + hpbMetaData[2] + hpbMetaData[3]), 32 * 1024 * 64),
                leftmin: hpbMetaData[4],
                rightmin: hpbMetaData[5],
                patternsLength: hpbMetaData[3]
            };
        }

        function createImportObject(baseData) {
            return {
                valueStoreOffset: baseData.valueStoreOffset,
                patternTrieOffset: baseData.patternTrieOffset,
                wordOffset: baseData.wordOffset,
                translatedWordOffset: baseData.translatedWordOffset,
                hyphenPointsOffset: baseData.hyphenPointsOffset,
                hyphenatedWordOffset: baseData.hyphenatedWordOffset,
                hpbTranslateOffset: baseData.hpbTranslateOffset,
                hpbPatternsOffset: baseData.hpbPatternsOffset,
                patternsLength: baseData.patternsLength
            };
        }

        function encloseHyphenateFunction(baseData, hyphenateFunc) {
            const heapBuffer = H.isWASMsupported
                ? baseData.wasmMemory.buffer
                : baseData.heapBuffer;
            const wordOffset = baseData.wordOffset;
            const hyphenatedWordOffset = baseData.hyphenatedWordOffset;
            const wordStore = (new Uint16Array(heapBuffer)).subarray(wordOffset >> 1, (wordOffset >> 1) + 64);
            const defLeftmin = baseData.leftmin;
            const defRightmin = baseData.rightmin;
            const hyphenatedWordStore = (new Uint16Array(heapBuffer)).subarray(hyphenatedWordOffset >> 1, (hyphenatedWordOffset >> 1) + 64);
            return function hyphenate(word, hyphenchar, leftmin, rightmin) {
                let i = 0;
                const wordLength = word.length;
                leftmin = leftmin || defLeftmin;
                rightmin = rightmin || defRightmin;
                wordStore[0] = wordLength + 2;
                wordStore[1] = 95;
                while (i < wordLength) {
                    wordStore[i + 2] = word.charCodeAt(i);
                    i += 1;
                }
                wordStore[i + 2] = 95;

                if (hyphenateFunc(leftmin, rightmin) === 1) {
                    i = 1;
                    word = "";
                    while (i < hyphenatedWordStore[0] + 1) {
                        word += String.fromCharCode(hyphenatedWordStore[i]);
                        i += 1;
                    }
                    if (hyphenchar !== "\u00AD") {
                        word = word.replace(/\u00AD/g, hyphenchar);
                    }
                }
                return word;
            };
        }

        function instantiateWasmEngine(lang) {
            Promise.all([H.binaries[lang], H.binaries.hyphenEngine]).then(
                function onAll(binaries) {
                    const hpbBuf = binaries[0];
                    const baseData = calculateBaseData(hpbBuf);
                    const wasmModule = binaries[1];
                    const wasmMemory = (H.specMems[lang].buffer.byteLength >= baseData.heapSize)
                        ? H.specMems[lang]
                        : new WebAssembly.Memory({
                            initial: baseData.heapSize / 65536,
                            maximum: 256
                        });
                    const ui32wasmMemory = new Uint32Array(wasmMemory.buffer);
                    ui32wasmMemory.set(new Uint32Array(hpbBuf), baseData.hpbOffset >> 2);
                    baseData.wasmMemory = wasmMemory;
                    WebAssembly.instantiate(wasmModule, {
                        ext: createImportObject(baseData),
                        env: {
                            memory: baseData.wasmMemory,
                            memoryBase: 0
                        }
                    }).then(
                        function runWasm(result) {
                            result.exports.convert();
                            prepareLanguagesObj(
                                lang,
                                encloseHyphenateFunction(baseData, result.exports.hyphenate),
                                decode((new Uint16Array(wasmMemory.buffer)).subarray(384, 640)),
                                baseData.leftmin,
                                baseData.rightmin
                            );
                        }
                    );
                }
            );
        }

        function instantiateAsmEngine(lang) {
            const hpbBuf = H.binaries[lang];
            const baseData = calculateBaseData(hpbBuf);
            const heapBuffer = (H.specMems[lang].byteLength >= baseData.heapSize)
                ? H.specMems[lang]
                : new ArrayBuffer(baseData.heapSize);
            const ui8Heap = new Uint8Array(heapBuffer);
            const ui8Patterns = new Uint8Array(hpbBuf);
            ui8Heap.set(ui8Patterns, baseData.hpbOffset);
            baseData.heapBuffer = heapBuffer;
            const theHyphenEngine = asmHyphenEngine(
                {
                    Uint8Array: window.Uint8Array,
                    Uint16Array: window.Uint16Array,
                    Int32Array: window.Int32Array,
                    Math: Math
                },
                createImportObject(baseData),
                baseData.heapBuffer
            );
            theHyphenEngine.convert();
            prepareLanguagesObj(
                lang,
                encloseHyphenateFunction(baseData, theHyphenEngine.hyphenate),
                decode((new Uint16Array(heapBuffer)).subarray(384, 640)),
                baseData.leftmin,
                baseData.rightmin
            );
        }

        let engineInstantiator;
        const hpb = [];
        function prepare(lang, engineType) {
            if (lang === "*") {
                if (engineType === "wasm") {
                    engineInstantiator = instantiateWasmEngine;
                } else if (engineType === "asm") {
                    engineInstantiator = instantiateAsmEngine;
                }
                hpb.forEach(function (lang) {
                    engineInstantiator(lang);
                });
            } else {
                if (engineInstantiator) {
                    engineInstantiator(lang);
                } else {
                    hpb.push(lang);
                }
            }
        }

        H.events.define(
            "contentLoaded",
            function () {
                autoSetMainLanguage();
                collectElements();
                H.events.dispatch("elementsReady");
            },
            false
        );

        H.events.define(
            "elementsReady",
            function () {
                elements.each(function (lang, values) {
                    if (H.hasOwnProperty("languages") && H.languages.hasOwnProperty(lang) && H.languages[lang].engineReady) {
                        hyphenateLangElements(lang, values);
                    }//else wait for "engineReady"-evt
                });
            },
            false
        );

        H.events.define(
            "engineLoaded",
            function (e) {
                prepare("*", e.msg);
            },
            false
        );

        H.events.define(
            "hpbLoaded",
            function (e) {
                prepare(e.msg, "*");
                //fires "engineReady", e.msg);
            },
            false
        );

        H.events.define(
            "engineReady",
            function (e) {
                if (H.elementsReady) {
                    hyphenateLangElements(e.msg, elements.list[e.msg]);
                } //else wait for "elementsReady"-evt
            },
            false
        );

        H.events.define(
            "hyphenopolyStart",
            null,
            true
        );

        H.events.define(
            "hyphenopolyEnd",
            function () {
                w.clearTimeout(C.timeOutHandler);
                w.document.documentElement.style.visibility = "visible";
            },
            false
        );

        H.events.define(
            "beforeElementHyphenation",
            null,
            true
        );

        H.events.define(
            "afterElementHyphenation",
            null,
            true
        );

        //register temporary defined handlers
        let eo = H.events.tempRegister.shift();
        while (eo) {
            H.events.addListener(eo.name, eo.handler, true);
            eo = H.events.tempRegister.shift();
        }
        delete H.events.tempRegister;

        H.events.dispatch("hyphenopolyStart", {msg: "Hyphenopoly started"});

        //clear Loader-timeout
        w.clearTimeout(H.setup.timeOutHandler);
        //renew timeout for the case something fails
        Object.defineProperty(C, "timeOutHandler", setProp(w.setTimeout(function () {
            H.events.dispatch("timeout", {delay: C.timeout});
        }, C.timeout), 2));

        //import and exec triggered events from loader
        H.events.deferred.forEach(function (eo) {
            H.events.dispatch(eo.name, eo.data);
        });
        delete H.events.deferred;

    }(w));
}(window));
