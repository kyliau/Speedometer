const BATCH = true;

class ElementHandle {
    constructor(element) {
        this.element = element;
    }

    click() {
        this.element.click();
    }

    focus() {
        this.element.focus();
    }

    type(text) {
        this.element.value = text;
        this.element.dispatchEvent(new Event('change'));
        this.element.dispatchEvent(new KeyboardEvent('keypress', {
            keyCode: 13,
            key: 'Enter',
            bubbles: true
        }));
    }
}

function createPage(contentWindow) {
    return BATCH ? new PageBatch() : new Page(contentWindow);
}

class ElementHandleBatch {
    static id = 0;

    constructor(requests, all) {
        this.requests = requests;
        this.key = ElementHandleBatch.id++;
        this.all = all;
    }

    click() {
        this.requests.push({
            name: 'click',
            key: this.key,
            all: this.all,
        });
    }

    focus() {
        this.requests.push({
            name: 'focus',
            key: this.key,
            all: this.all,
        });
    }

    type(text) {
        this.requests.push({
            name: 'type',
            key: this.key,
            all: this.all,
            text,
        });
    }
}

class PageBatch {
    constructor() {
        this.requests = [];
    }

    async waitForElement(selector) {
        const element = new ElementHandleBatch(this.requests, false);
        this.requests.push({
            name: 'waitForElement',
            selector,
            key: element.key,
        });
        return element;
    }

    querySelector(selector) {
        const element = new ElementHandleBatch(this.requests, false);
        this.requests.push({
            name: 'querySelector',
            selector,
            key: element.key,
        });
        return element;
    }

    querySelectorAll(selector) {
        const element = new ElementHandleBatch(this.requests, true);
        this.requests.push({
            name: 'querySelectorAll',
            selector,
            key: element.key,
        });
        return [element];
    }

    getElementById(id) {
        const element = new ElementHandleBatch(this.requests, false);
        this.requests.push({
            name: 'getElementById',
            id,
            key: element.key,
        });
        return element;
    }
}

class Page {
    constructor(contentWindow) {
        this.contentWindow = contentWindow;
        this.contentDocument = contentWindow.document;
    }

    waitForElement(selector) {
        return new Promise((resolve) => {

            const resolveIfReady = () => {
                var element = this.querySelector(selector);
                if (element) {
                    window.requestAnimationFrame(function () {
                        return resolve(element);
                    });
                    return;
                }
                setTimeout(resolveIfReady, 50);
            };

            resolveIfReady();
        });
    }

    querySelector(selector) {
        const element = this.contentDocument.querySelector(selector);
        return element ? new ElementHandle(element) : null;
    }

    querySelectorAll(selector) {
        const elements = [...this.contentDocument.querySelectorAll(selector)];
        return elements.map(element => new ElementHandle(element));
    }

    getElementById(id) {
        const element = this.contentDocument.getElementById(id);
        return element ? new ElementHandle(element) : null;
    }
}

function BenchmarkTestStep(testName, testFunction) {
    this.name = testName;
    this.run = testFunction;
}

function BenchmarkRunner(suites, client) {
    this._suites = suites;
    this._client = client;
}

BenchmarkRunner.prototype.waitForElement = function (selector) {
    return new Promise((resolve) => {
        const contentDocument = this._frame.contentDocument;

        function resolveIfReady() {
            var element = contentDocument.querySelector(selector);
            if (element) {
                window.requestAnimationFrame(function () {
                    return resolve(element);
                });
                return;
            }
            setTimeout(resolveIfReady, 50);
        }

        resolveIfReady();
    });
}

BenchmarkRunner.prototype._removeFrame = function () {
    if (this._frame) {
        this._frame.parentNode.removeChild(this._frame);
        this._frame = null;
    }
}

BenchmarkRunner.prototype._appendFrame = function (src) {
    var frame = document.createElement('iframe');
    frame.style.width = '800px';
    frame.style.height = '600px';
    frame.style.border = '0px none';
    frame.style.position = 'absolute';
    frame.setAttribute('scrolling', 'no');

    var marginLeft = parseInt(getComputedStyle(document.body).marginLeft);
    var marginTop = parseInt(getComputedStyle(document.body).marginTop);
    if (window.innerWidth > 800 + marginLeft && window.innerHeight > 600 + marginTop) {
        frame.style.left = marginLeft + 'px';
        frame.style.top = marginTop + 'px';
    } else {
        frame.style.left = '0px';
        frame.style.top = '0px';
    }

    if (this._client && this._client.willAddTestFrame)
        this._client.willAddTestFrame(frame);

    document.body.insertBefore(frame, document.body.firstChild);
    this._frame = frame;
    return frame;
}

BenchmarkRunner.prototype._writeMark = function (name) {
    if (window.performance && window.performance.mark)
        window.performance.mark(name);
}

// This function ought be as simple as possible. Don't even use Promise.
BenchmarkRunner.prototype._runTest = function (suite, test, prepareReturnValue, callback) {
    var self = this;
    var now = window.performance && window.performance.now ? function () { return window.performance.now(); } : Date.now;

    var contentWindow = self._frame.contentWindow;
    var contentDocument = self._frame.contentDocument;

    self._writeMark(suite.name + '.' + test.name + '-start');
    var startTime = now();
    const page = createPage(contentWindow);
    test.run(page);
    page.requests && console.info("runTest - " + test.name, page.requests);
    var endTime = now();
    self._writeMark(suite.name + '.' + test.name + '-sync-end');

    var syncTime = endTime - startTime;

    var startTime = now();
    setTimeout(function () {
        // Some browsers don't immediately update the layout for paint.
        // Force the layout here to ensure we're measuring the layout time.
        var height = self._frame.contentDocument.body.getBoundingClientRect().height;
        var endTime = now();
        self._frame.contentWindow._unusedHeightValue = height; // Prevent dead code elimination.
        self._writeMark(suite.name + '.' + test.name + '-async-end');
        window.requestAnimationFrame(function () {
            callback(syncTime, endTime - startTime, height);
        });
    }, 0);
}

function BenchmarkState(suites) {
    this._suites = suites;
    this._suiteIndex = -1;
    this._testIndex = 0;
    this.next();
}

BenchmarkState.prototype.currentSuite = function () {
    return this._suites[this._suiteIndex];
}

BenchmarkState.prototype.currentTest = function () {
    var suite = this.currentSuite();
    return suite ? suite.tests[this._testIndex] : null;
}

BenchmarkState.prototype.next = function () {
    this._testIndex++;

    var suite = this._suites[this._suiteIndex];
    if (suite && this._testIndex < suite.tests.length)
        return this;

    this._testIndex = 0;
    do {
        this._suiteIndex++;
    } while (this._suiteIndex < this._suites.length && this._suites[this._suiteIndex].disabled);

    return this;
}

BenchmarkState.prototype.isFirstTest = function () {
    return !this._testIndex;
}

BenchmarkState.prototype.prepareCurrentSuite = function (frame) {
    const suite = this.currentSuite();
    return new Promise((resolve) => {
        frame.onload = function () {
            const page = createPage(frame.contentWindow);
            suite.prepare(page).then(() => {
                page.requests && console.info("prepare", page.requests);
                resolve();
            });
        }
        frame.src = 'resources/' + suite.url;
    });
}

BenchmarkRunner.prototype.step = function (state) {
    if (!state) {
        state = new BenchmarkState(this._suites);
        this._measuredValues = { tests: {}, total: 0, mean: NaN, geomean: NaN, score: NaN };
    }

    var suite = state.currentSuite();
    if (!suite) {
        this._finalize();
        return Promise.resolve();
    }

    if (state.isFirstTest()) {
        this._removeFrame();
        var self = this;
        return state.prepareCurrentSuite(this._appendFrame()).then(function (prepareReturnValue) {
            return self._runTestAndRecordResults(state);
        });
    }

    return this._runTestAndRecordResults(state);
}

BenchmarkRunner.prototype.runAllSteps = function (startingState) {
    var nextCallee = this.runAllSteps.bind(this);
    this.step(startingState).then(function (nextState) {
        if (nextState)
            nextCallee(nextState);
    });
}

BenchmarkRunner.prototype.runMultipleIterations = function (iterationCount) {
    var self = this;
    var currentIteration = 0;

    this._runNextIteration = function () {
        currentIteration++;
        if (currentIteration < iterationCount)
            self.runAllSteps();
        else if (this._client && this._client.didFinishLastIteration)
            this._client.didFinishLastIteration();
    }

    if (this._client && this._client.willStartFirstIteration)
        this._client.willStartFirstIteration(iterationCount);

    self.runAllSteps();
}

BenchmarkRunner.prototype._runTestAndRecordResults = function (state) {
    return new Promise((resolve) => {
        const suite = state.currentSuite();
        const test = state.currentTest();

        if (this._client && this._client.willRunTest)
            this._client.willRunTest(suite, test);

        setTimeout(() => {
            this._runTest(suite, test, this._prepareReturnValue, (syncTime, asyncTime) => {
                const suiteResults = this._measuredValues.tests[suite.name] || { tests: {}, total: 0 };
                const total = syncTime + asyncTime;
                this._measuredValues.tests[suite.name] = suiteResults;
                suiteResults.tests[test.name] = { tests: { 'Sync': syncTime, 'Async': asyncTime }, total: total };
                suiteResults.total += total;

                if (this._client && this._client.didRunTest)
                    this._client.didRunTest(suite, test);

                state.next();
                resolve(state);
            });
        }, 0);
    });
}

BenchmarkRunner.prototype._finalize = function () {
    this._removeFrame();

    if (this._client && this._client.didRunSuites) {
        var product = 1;
        var values = [];
        for (var suiteName in this._measuredValues.tests) {
            var suiteTotal = this._measuredValues.tests[suiteName].total;
            product *= suiteTotal;
            values.push(suiteTotal);
        }

        values.sort(function (a, b) { return a - b }); // Avoid the loss of significance for the sum.
        var total = values.reduce(function (a, b) { return a + b });
        var geomean = Math.pow(product, 1 / values.length);

        var correctionFactor = 3; // This factor makes the test score look reasonably fit within 0 to 140.
        this._measuredValues.total = total;
        this._measuredValues.mean = total / values.length;
        this._measuredValues.geomean = geomean;
        this._measuredValues.score = 60 * 1000 / geomean / correctionFactor;
        this._client.didRunSuites(this._measuredValues);
    }

    if (this._runNextIteration)
        this._runNextIteration();
}