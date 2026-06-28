// PDF.js configuration
const pdfjsLib = window['pdfjs-dist/build/pdf'];

// Application State
let pdfDoc = null;
let pageNum = 1;
let pageRendering = false;
let pageNumPending = null;
let scale = 1.5;
let extractedText = "";

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
const canvasContainer = document.getElementById('canvas-container');
const readerModeContainer = document.getElementById('reader-mode-container');
const readerModeContent = document.getElementById('reader-mode-content');
let isReaderMode = false;

const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const voiceSelect = document.getElementById('voice-select');
const rateSlider = document.getElementById('rate-slider');
const rateValueDisplay = document.getElementById('rate-value');
const reverseToggle = document.getElementById('reverse-toggle');

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
    });
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
    pageNum--;
    queueRenderPage(pageNum);
    stopSpeaking();
}

function onNextPage() {
    if (pageNum >= pdfDoc.numPages) {
        return;
    }
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
    // Unlock audio element for iOS/Mobile on first user interaction
    currentCloudAudio.play().catch(e => {});
    
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
        
        if (currentChunkText.length + word.length < 150) {
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
        if (isCloudSpeaking) {
            playNextCloudChunk();
        }
    };
    
    currentCloudAudio.onerror = () => {
        console.error("Error playing cloud TTS");
        if (isCloudSpeaking) {
            playNextCloudChunk(); // skip chunk on error
        }
    };
    
    currentCloudAudio.play();
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
