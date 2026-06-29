// PDF.js configuration
const pdfjsLib = window['pdfjs-dist/build/pdf'];

// Application State
let pdfDoc = null;
let pageNum = 1;
let pageRendering = false;
let pageNumPending = null;
let scale = 1.5;
let extractedText = "";
let ocrWorker = null;
let isOCRRunning = false;
let ocrTargetPage = null;
let ocrHideTimeout = null;
let cloudTTSErrorCount = 0;

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

// DOM Elements
const canvas = document.getElementById('pdf-canvas');
const ctx = canvas.getContext('2d');
const fileInput = document.getElementById('pdf-upload');
const fileNameDisplay = document.getElementById('file-name');
const pageNumDisplay = document.getElementById('page-num');
const pageCountDisplay = document.getElementById('page-count');
const loadingSpinner = document.getElementById('loading-spinner');
const textPreview = document.getElementById('text-preview');

const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnReaderMode = document.getElementById('btn-reader-mode');
const btnOCR = document.getElementById('btn-ocr');
const canvasContainer = document.getElementById('canvas-container');
const readerModeContainer = document.getElementById('reader-mode-container');
const readerModeContent = document.getElementById('reader-mode-content');
const ocrStatusEl = document.getElementById('ocr-status');
const ocrStatusText = document.getElementById('ocr-status-text');
const ocrProgressFill = document.getElementById('ocr-progress-fill');
const ocrProgressPercent = document.getElementById('ocr-progress-percent');
let isReaderMode = false;

const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const voiceSelect = document.getElementById('voice-select');
const rateSlider = document.getElementById('rate-slider');
const rateValueDisplay = document.getElementById('rate-value');
const reverseToggle = document.getElementById('reverse-toggle');
const autoReadToggle = document.getElementById('autoread-toggle');
let autoReadPending = false;

// Text-to-Speech Synth
const synth = window.speechSynthesis;
let voices = [];

// Initialize Voices
function populateVoiceList() {
    voices = synth.getVoices();
    
    voiceSelect.innerHTML = '';
    
    // Add Cloud TTS Option always at the top
    const cloudOption = document.createElement('option');
    cloudOption.textContent = 'صوت السحابة (متصل بالإنترنت) - Google Cloud';
    cloudOption.setAttribute('data-lang', 'ar');
    cloudOption.setAttribute('data-name', 'cloud-google');
    voiceSelect.appendChild(cloudOption);
    
    // Filter for Arabic voices (case-insensitive)
    const arabicVoices = voices.filter(v => v.lang.toLowerCase().startsWith('ar'));
    const displayVoices = arabicVoices.length > 0 ? arabicVoices : voices; 
    
    if (displayVoices.length > 0) {
        displayVoices.forEach((voice, i) => {
            const option = document.createElement('option');
            option.textContent = `${voice.name} (${voice.lang})`;
            if (voice.default) {
                option.textContent += ' — Default';
            }
            option.setAttribute('data-lang', voice.lang);
            option.setAttribute('data-name', voice.name);
            voiceSelect.appendChild(option);
        });
    }
}

populateVoiceList();
if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoiceList;
}

// PDF Rendering
function renderPage(num) {
    pageRendering = true;
    loadingSpinner.classList.remove('hidden');
    
    pdfDoc.getPage(num).then(function(page) {
        const viewport = page.getViewport({scale: scale});
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const renderContext = {
            canvasContext: ctx,
            viewport: viewport
        };
        const renderTask = page.render(renderContext);

        renderTask.promise.then(function() {
            pageRendering = false;
            loadingSpinner.classList.add('hidden');
            if (pageNumPending !== null) {
                renderPage(pageNumPending);
                pageNumPending = null;
            }
        });

        // Extract Text
        extractText(page);
    });

    pageNumDisplay.textContent = num;
    if (fileInput.files.length > 0) {
        localStorage.setItem('pdf-page-' + fileInput.files[0].name, num);
    }
}

// Extract text content from the PDF page
function extractText(page) {
    page.getTextContent().then(function(textContent) {
        let textItems = textContent.items;
        let finalString = "";

        let lastY = -1;
        for (let i = 0; i < textItems.length; i++) {
            let item = textItems[i];
            
            // Add a newline if the Y coordinate changes significantly
            if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) {
                finalString += "\n";
            }
            
            finalString += item.str;
            
            // Add space if there is a wide gap between items (word boundary)
            if (i < textItems.length - 1) {
                let nextItem = textItems[i+1];
                let dist = Math.abs(item.transform[4] - nextItem.transform[4]);
                // If the distance is larger than the width of the character, it's likely a space
                if (dist > item.width * 1.5 && item.str.trim() !== "") {
                    finalString += " ";
                }
            }
            
            lastY = item.transform[5];
        }
        
        extractedText = finalString;
        updateTextPreview();
        
        // Auto-detect scanned page: if extracted text is very short, run OCR
        const trimmedText = finalString.replace(/\s+/g, '');
        if (trimmedText.length < 10) {
            runOCR();
        }
    });
}

// OCR Functions
async function initOCRWorker() {
    if (ocrWorker) return ocrWorker;
    
    showOCRStatus('جاري تحميل محرك OCR...', 0);
    
    ocrWorker = await Tesseract.createWorker('ara', 1, {
        logger: m => {
            if (m.status === 'recognizing text') {
                const pct = Math.round(m.progress * 100);
                showOCRStatus('جاري التعرف على النص...', pct);
            } else if (m.status === 'loading language traineddata') {
                const pct = Math.round(m.progress * 100);
                showOCRStatus('جاري تحميل بيانات اللغة العربية...', pct);
            }
        }
    });
    
    return ocrWorker;
}

async function runOCR() {
    if (isOCRRunning || !pdfDoc) return;
    
    isOCRRunning = true;
    ocrTargetPage = pageNum;
    btnOCR.disabled = true;
    
    // Clear any pending hide timeout
    if (ocrHideTimeout) {
        clearTimeout(ocrHideTimeout);
        ocrHideTimeout = null;
    }
    
    showOCRStatus('جاري التحضير...', 0);
    
    try {
        const worker = await initOCRWorker();
        
        // Check if user navigated away during worker init
        if (ocrTargetPage !== pageNum) {
            isOCRRunning = false;
            hideOCRStatus();
            if (pdfDoc) btnOCR.disabled = false;
            return;
        }
        
        // Use a higher-resolution canvas for better OCR accuracy
        const page = await pdfDoc.getPage(ocrTargetPage);
        const ocrScale = 3;
        const viewport = page.getViewport({ scale: ocrScale });
        
        const ocrCanvas = document.createElement('canvas');
        ocrCanvas.width = viewport.width;
        ocrCanvas.height = viewport.height;
        const ocrCtx = ocrCanvas.getContext('2d');
        
        showOCRStatus('جاري تجهيز الصفحة...', 5);
        
        await page.render({
            canvasContext: ocrCtx,
            viewport: viewport
        }).promise;
        
        // Check again after render
        if (ocrTargetPage !== pageNum) {
            isOCRRunning = false;
            hideOCRStatus();
            if (pdfDoc) btnOCR.disabled = false;
            return;
        }
        
        showOCRStatus('جاري التعرف على النص...', 10);
        
        const { data: { text } } = await worker.recognize(ocrCanvas);
        
        // Discard stale results if user changed page during OCR
        if (ocrTargetPage !== pageNum) {
            isOCRRunning = false;
            hideOCRStatus();
            if (pdfDoc) btnOCR.disabled = false;
            return;
        }
        
        if (text && text.trim().length > 0) {
            extractedText = text;
            updateTextPreview();
            showOCRStatus('تم التعرف على النص بنجاح ✓', 100);
        } else {
            showOCRStatus('لم يتم العثور على نص في هذه الصفحة', 100);
        }
        
        ocrHideTimeout = setTimeout(() => {
            hideOCRStatus();
        }, 3000);
        
    } catch (err) {
        console.error('OCR Error:', err);
        showOCRStatus('خطأ في التعرف على النص', 0);
        ocrHideTimeout = setTimeout(() => {
            hideOCRStatus();
        }, 3000);
    } finally {
        isOCRRunning = false;
        if (pdfDoc) btnOCR.disabled = false;
    }
}

function showOCRStatus(message, percent) {
    ocrStatusEl.classList.remove('hidden');
    ocrStatusText.textContent = message;
    ocrProgressFill.style.width = percent + '%';
    ocrProgressPercent.textContent = percent + '%';
}

function hideOCRStatus() {
    ocrStatusEl.classList.add('hidden');
    ocrProgressFill.style.width = '0%';
    ocrProgressPercent.textContent = '0%';
}

// Update the textarea preview and handle the reverse toggle logic
function updateTextPreview() {
    let textToDisplay = extractedText;
    
    // If the PDF encodes text backwards, this toggle attempts to fix it
    if (reverseToggle.checked) {
        textToDisplay = textToDisplay.split('').reverse().join('');
    }
    
    textPreview.value = textToDisplay;
    readerModeContent.textContent = textToDisplay;
    
    if (textToDisplay.trim().length > 0) {
        btnPlay.disabled = false;
    } else {
        btnPlay.disabled = true;
    }
    
    if (autoReadPending && textToDisplay.trim().length > 0) {
        autoReadPending = false;
        setTimeout(() => speak(), 300);
    }
}

function queueRenderPage(num) {
    if (pageRendering) {
        pageNumPending = num;
    } else {
        renderPage(num);
    }
}

function onPrevPage() {
    if (pageNum <= 1) {
        return;
    }
    autoReadPending = false;
    pageNum--;
    queueRenderPage(pageNum);
    stopSpeaking();
}

function onNextPage() {
    if (pageNum >= pdfDoc.numPages) {
        return;
    }
    autoReadPending = false;
    pageNum++;
    queueRenderPage(pageNum);
    stopSpeaking();
}

// PDF Upload Handler
fileInput.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file || file.type !== 'application/pdf') {
        alert('الرجاء اختيار ملف PDF صحيح.');
        return;
    }

    fileNameDisplay.textContent = file.name;
    const fileReader = new FileReader();

    fileReader.onload = function() {
        const typedarray = new Uint8Array(this.result);
        
        loadingSpinner.classList.remove('hidden');
        
        const loadingTask = pdfjsLib.getDocument({
            data: typedarray,
            cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/'
        });

        loadingTask.promise.then(function(pdfDoc_) {
            pdfDoc = pdfDoc_;
            pageCountDisplay.textContent = pdfDoc.numPages;
            
            // Enable controls
            btnPrev.disabled = false;
            btnNext.disabled = false;
            btnZoomIn.disabled = false;
            btnZoomOut.disabled = false;
            btnReaderMode.disabled = false;
            btnOCR.disabled = false;
            
            const savedPage = localStorage.getItem('pdf-page-' + file.name);
            if (savedPage && parseInt(savedPage) > 0 && parseInt(savedPage) <= pdfDoc.numPages) {
                pageNum = parseInt(savedPage);
            } else {
                pageNum = 1;
            }
            
            queueRenderPage(pageNum);
        }).catch(err => {
            console.error('Error loading PDF: ', err);
            alert('خطأ في تحميل ملف PDF');
            loadingSpinner.classList.add('hidden');
        });
    };

    fileReader.onerror = function() {
        console.error('FileReader error:', fileReader.error);
        showToast('خطأ في قراءة الملف. تأكد من أن الملف غير تالف وحاول مرة أخرى.');
        loadingSpinner.classList.add('hidden');
    };

    fileReader.readAsArrayBuffer(file);
});

// Event Listeners for PDF controls
btnPrev.addEventListener('click', onPrevPage);
btnNext.addEventListener('click', onNextPage);

btnZoomIn.addEventListener('click', () => {
    scale += 0.25;
    queueRenderPage(pageNum);
});

btnZoomOut.addEventListener('click', () => {
    if (scale <= 0.5) return;
    scale -= 0.25;
    queueRenderPage(pageNum);
});

btnReaderMode.addEventListener('click', () => {
    isReaderMode = !isReaderMode;
    if (isReaderMode) {
        canvasContainer.classList.add('hidden');
        readerModeContainer.classList.remove('hidden');
        btnReaderMode.style.background = 'var(--accent-color)';
        btnReaderMode.style.color = 'white';
    } else {
        canvasContainer.classList.remove('hidden');
        readerModeContainer.classList.add('hidden');
        btnReaderMode.style.background = 'rgba(59, 130, 246, 0.2)';
        btnReaderMode.style.color = 'var(--text-secondary)';
    }
});

reverseToggle.addEventListener('change', () => {
    stopSpeaking();
    updateTextPreview();
});

voiceSelect.addEventListener('change', () => {
    stopSpeaking();
});

btnOCR.addEventListener('click', () => {
    runOCR();
});

rateSlider.addEventListener('input', (e) => {
    rateValueDisplay.textContent = e.target.value;
    if (currentCloudAudio) {
        currentCloudAudio.playbackRate = parseFloat(e.target.value);
    }
});

// TTS Controls
let cloudAudioQueue = [];
let cloudChunks = [];
let currentCloudAudio = new Audio();
let isCloudSpeaking = false;

function speak() {
    const textToSpeak = textPreview.value.trim();
    if (textToSpeak === '') return;

    const selectedOptionDataName = voiceSelect.selectedOptions.length > 0 ? voiceSelect.selectedOptions[0].getAttribute('data-name') : '';

    if (selectedOptionDataName === 'cloud-google') {
        playCloudTTS(textToSpeak);
        return;
    }

    // Default Web Speech API
    if (synth.speaking && !synth.paused) {
        return;
    }
    
    if (synth.paused) {
        synth.resume();
        btnPlay.disabled = true;
        btnPause.disabled = false;
        return;
    }

    const utterThis = new SpeechSynthesisUtterance(textToSpeak);
    
    if (voiceSelect.selectedOptions.length > 0) {
        const allVoices = synth.getVoices();
        for (let i = 0; i < allVoices.length; i++) {
            if (allVoices[i].name === selectedOptionDataName) {
                utterThis.voice = allVoices[i];
                break;
            }
        }
    }
    
    utterThis.rate = parseFloat(rateSlider.value);
    
    utterThis.onstart = () => {
        btnPlay.disabled = true;
        btnPause.disabled = false;
        btnStop.disabled = false;
    };
    
    utterThis.onboundary = (e) => {
        if (e.name === 'word') {
            const before = textToSpeak.substring(0, e.charIndex);
            
            // find end of word (first whitespace)
            let match = textToSpeak.substring(e.charIndex).match(/\s/);
            let endOfWord = match ? e.charIndex + match.index : textToSpeak.length;
            
            const word = textToSpeak.substring(e.charIndex, endOfWord);
            const after = textToSpeak.substring(endOfWord);
            
            readerModeContent.innerHTML = escapeHTML(before) + '<span class="highlight">' + escapeHTML(word) + '</span>' + escapeHTML(after);
        }
    };
    
    utterThis.onend = () => {
        btnPlay.disabled = false;
        btnPause.disabled = true;
        btnStop.disabled = true;
        readerModeContent.textContent = textPreview.value;
        
        // Auto-read next page
        if (autoReadToggle.checked && pdfDoc && pageNum < pdfDoc.numPages) {
            autoReadPending = true;
            pageNum++;
            queueRenderPage(pageNum);
        }
    };
    
    utterThis.onerror = (e) => {
        console.error('SpeechSynthesisUtterance.onerror', e);
        btnPlay.disabled = false;
        btnPause.disabled = true;
        btnStop.disabled = true;
        readerModeContent.textContent = textPreview.value;
    };
    
    synth.speak(utterThis);
}

function playCloudTTS(text) {
    if (isCloudSpeaking && currentCloudAudio && currentCloudAudio.paused) {
        currentCloudAudio.play();
        btnPlay.disabled = true;
        btnPause.disabled = false;
        return;
    }

    if (isCloudSpeaking) return;

    // Reset error counter for each new playback session
    cloudTTSErrorCount = 0;

    let regex = /\S+/g;
    let match;
    let currentChunkText = "";
    let currentStartIndex = -1;
    let lastEndIndex = -1;
    
    cloudAudioQueue = [];
    cloudChunks = [];
    
    while ((match = regex.exec(text)) !== null) {
        let word = match[0];
        let wordIndex = match.index;
        
        if (currentStartIndex === -1) {
            currentStartIndex = wordIndex;
        }
        
        if (currentChunkText.length + word.length < 100) {
            currentChunkText += word + " ";
            lastEndIndex = wordIndex + word.length;
        } else {
            cloudAudioQueue.push(currentChunkText.trim());
            cloudChunks.push({start: currentStartIndex, end: lastEndIndex});
            
            currentChunkText = word + " ";
            currentStartIndex = wordIndex;
            lastEndIndex = wordIndex + word.length;
        }
    }
    if (currentChunkText.trim().length > 0) {
        cloudAudioQueue.push(currentChunkText.trim());
        cloudChunks.push({start: currentStartIndex, end: lastEndIndex});
    }
    
    isCloudSpeaking = true;
    btnPlay.disabled = true;
    btnPause.disabled = false;
    btnStop.disabled = false;
    playNextCloudChunk();
}

function playNextCloudChunk() {
    if (cloudAudioQueue.length === 0 || !isCloudSpeaking) {
        isCloudSpeaking = false;
        currentCloudAudio = null;
        btnPlay.disabled = false;
        btnPause.disabled = true;
        btnStop.disabled = true;
        readerModeContent.textContent = textPreview.value;
        
        // Auto-read next page
        if (autoReadToggle.checked && pdfDoc && pageNum < pdfDoc.numPages) {
            autoReadPending = true;
            pageNum++;
            queueRenderPage(pageNum);
        }
        return;
    }
    
    let textChunk = cloudAudioQueue.shift();
    let chunkInfo = cloudChunks.shift();
    
    let url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ar&client=tw-ob&q=${encodeURIComponent(textChunk)}`;
    
    let fullText = textPreview.value;
    if (chunkInfo) {
        let before = fullText.substring(0, chunkInfo.start);
        let chunkStr = fullText.substring(chunkInfo.start, chunkInfo.end);
        let after = fullText.substring(chunkInfo.end);
        readerModeContent.innerHTML = escapeHTML(before) + '<span class="highlight">' + escapeHTML(chunkStr) + '</span>' + escapeHTML(after);
    }
    
    currentCloudAudio.src = url;
    currentCloudAudio.playbackRate = parseFloat(rateSlider.value);
    
    currentCloudAudio.onended = () => {
        cloudTTSErrorCount = 0; // Reset on success
        if (isCloudSpeaking) {
            playNextCloudChunk();
        }
    };
    
    currentCloudAudio.onerror = () => {
        cloudTTSErrorCount++;
        console.error('Cloud TTS error (attempt ' + cloudTTSErrorCount + ')');
        
        if (cloudTTSErrorCount >= 2) {
            // Cloud TTS is not working, stop and notify user
            isCloudSpeaking = false;
            cloudAudioQueue = [];
            cloudChunks = [];
            currentCloudAudio = null;
            btnPlay.disabled = false;
            btnPause.disabled = true;
            btnStop.disabled = true;
            readerModeContent.textContent = textPreview.value;
            
            // Auto-switch to a local voice if available
            if (voiceSelect.options.length > 1) {
                voiceSelect.selectedIndex = 1;
                showToast('صوت السحابة غير متاح. تم التبديل إلى صوت محلي — اضغط "قراءة" مرة أخرى.');
            } else {
                showToast('صوت السحابة غير متاح. لا توجد أصوات محلية بديلة.');
            }
            return;
        }
        
        // First error: skip this chunk and try next
        if (isCloudSpeaking) {
            playNextCloudChunk();
        }
    };
    
    currentCloudAudio.play().catch(() => {
        // play() promise rejection (e.g. autoplay policy)
        cloudTTSErrorCount++;
        if (cloudTTSErrorCount >= 2) {
            isCloudSpeaking = false;
            cloudAudioQueue = [];
            cloudChunks = [];
            currentCloudAudio = null;
            btnPlay.disabled = false;
            btnPause.disabled = true;
            btnStop.disabled = true;
            readerModeContent.textContent = textPreview.value;
            
            if (voiceSelect.options.length > 1) {
                voiceSelect.selectedIndex = 1;
                showToast('صوت السحابة غير متاح. تم التبديل إلى صوت محلي — اضغط "قراءة" مرة أخرى.');
            } else {
                showToast('صوت السحابة غير متاح. لا توجد أصوات محلية بديلة.');
            }
        } else if (isCloudSpeaking) {
            playNextCloudChunk();
        }
    });
}

function pauseSpeaking() {
    const selectedOptionDataName = voiceSelect.selectedOptions.length > 0 ? voiceSelect.selectedOptions[0].getAttribute('data-name') : '';

    if (selectedOptionDataName === 'cloud-google') {
        if (currentCloudAudio && !currentCloudAudio.paused) {
            currentCloudAudio.pause();
            btnPlay.disabled = false;
            btnPause.disabled = true;
        }
        return;
    }

    if (synth.speaking && !synth.paused) {
        synth.pause();
        btnPlay.disabled = false;
        btnPause.disabled = true;
    }
}

function stopSpeaking() {
    autoReadPending = false;
    const selectedOptionDataName = voiceSelect.selectedOptions.length > 0 ? voiceSelect.selectedOptions[0].getAttribute('data-name') : '';

    if (selectedOptionDataName === 'cloud-google') {
        isCloudSpeaking = false;
        if (currentCloudAudio) {
            currentCloudAudio.pause();
            currentCloudAudio.src = "";
        }
        cloudAudioQueue = [];
        btnPlay.disabled = false;
        btnPause.disabled = true;
        btnStop.disabled = true;
        readerModeContent.textContent = textPreview.value;
        return;
    }

    if (synth.speaking) {
        synth.cancel();
        btnPlay.disabled = false;
        btnPause.disabled = true;
        btnStop.disabled = true;
        readerModeContent.textContent = textPreview.value;
    }
}

btnPlay.addEventListener('click', speak);
btnPause.addEventListener('click', pauseSpeaking);
btnStop.addEventListener('click', stopSpeaking);

// Toast notification system
const toastEl = document.getElementById('toast-notification');
const toastMessage = document.getElementById('toast-message');
let toastTimeout = null;

function showToast(message) {
    if (toastTimeout) clearTimeout(toastTimeout);
    toastMessage.textContent = message;
    toastEl.classList.remove('hidden');
    toastEl.classList.add('toast-show');
    
    toastTimeout = setTimeout(() => {
        toastEl.classList.remove('toast-show');
        toastEl.classList.add('toast-hide');
        setTimeout(() => {
            toastEl.classList.add('hidden');
            toastEl.classList.remove('toast-hide');
        }, 400);
    }, 5000);
}
