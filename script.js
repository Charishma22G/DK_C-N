let weatherData = null;
let simulationResults = null;
let chart = null;
let dateOnX = false;
let selectedExcelFile = null;
let excelFileCounter = 1;
let isWeatherDaily = false;

const modelParams = {
    R_SOM: 0.00210,
    S_SOM: 0.463,
    R_substrates: {
        1: 0.1490, 2: 0.1140, 3: 0.1490, 4: 0.1490, 5: 0.1660, 6: 0.0400
    },
    S_substrates: {
        1: 0.660, 2: 0.670, 3: 0.660, 4: 0.660, 5: 0.640, 6: 0.62  
    },
    CNratioSOM: 10.0,
    CNratioMicrobeMax: 7.0,
    CNratioMicrobeMin: 5.0,
    DAratioMin: 3.3,
    DAratioMax: 14.0,
    Tref: 10.0,
    Q10: 2.0,
    soilTempDiff: 2.0,
    TmaxCutoff: 35.0,
    textureAdjustment: {
        Sand: { R: 1.00, S: 1.00 },
        Loam: { R: 1.39, S: 1.08 },
        Clay: { R: 1.78, S: 1.15 }
    }
};

function createSafeDate(dateString) {
    const parts = dateString.split('-');
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    const day = parseInt(parts[2]);
    return new Date(year, month, day);
}

function formatDateForDisplay(date) {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const year = date.getFullYear().toString().slice(-2);
    return `${month}/${day}/${year}`;
}

function dayOfYearToDate(year, dayOfYear) {
    const date = new Date(year, 0, 1);
    date.setDate(dayOfYear);
    return date;
}

function dateToDay(date) {
    const start = new Date(date.getFullYear(), 0, 1);
    const diff = date.getTime() - start.getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function showError(message) {
    document.getElementById('error-message').textContent = message;
    document.getElementById('error-dialog').style.display = 'block';
}

function closeErrorDialog() {
    document.getElementById('error-dialog').style.display = 'none';
}

function getSubstrateTypeName(code) {
    const names = {
        1: 'Cereal crop residues (1)',
        2: 'Cereal crop roots (2)', 
        3: 'Legume residues (3)',
        4: 'Legume roots (4)',
        5: 'Green manures (5)',
        6: 'Animal manures (6)'
    };
    return names[code] || `Substrate type ${code}`;
}

function calculateTemperatureCoeff(tmax, tmin) {
    
    const slope = 1.0 / modelParams.Tref;
    
    if (tmax > modelParams.TmaxCutoff) {
        tmax = modelParams.TmaxCutoff;
    }
    
    let tmean = (tmax + tmin) / 2.0;
    tmean = tmean + modelParams.soilTempDiff;
    
    if (tmean < 0) {
        tmean = 0;
    }
    
    let tempCoeff;
    
    if (tmean >= modelParams.Tref) {
        tempCoeff = Math.pow(modelParams.Q10, (tmean - modelParams.Tref) / 10.0);
    } else {
        tempCoeff = tmean * slope;
    }
    
    if (tempCoeff <= 0) {
        tempCoeff = 0.0001;
    }
    
    return tempCoeff;
}

function calculateNDynamics(C_dissim, C_assim, cnRatio, cnRatioMicrobe) {
    const grossNrelease = (C_dissim + C_assim) / cnRatio;
    const microbeNuptake = C_assim / cnRatioMicrobe;
    return grossNrelease - microbeNuptake;
}

function calculateDecompositionSOM(oldValue, oldTime, currentTime, R, S, tempCoeff, oldSmallK) {
    if (currentTime < 30.0) {
        const firstMonth_K = R * Math.pow(30.0, -S);
        const newSmallK = (1.0 - S) * firstMonth_K;
        return {
            newValue: oldValue * Math.exp(-firstMonth_K * tempCoeff),
            newSmallK: newSmallK
        };
    } else {
        const R_new = R * tempCoeff;  
        const S1 = 0.933 * Math.pow(R, 0.179);
        const S2 = 0.933 * Math.pow(R_new, 0.179);
        const change = (S2 - S1) / S1;
        let adj_S = S * (1.0 + change);
        
        if (adj_S >= 1.0) adj_S = 0.999;
        if (adj_S <= 0.0) adj_S = 0.001;
        
        const small_k1 = oldSmallK;
        const newSmallK = small_k1 / Math.pow(oldTime, -adj_S) * Math.pow(currentTime, -adj_S);
        
        const denominator = (1.0 - adj_S);
        
        if (Math.abs(denominator) < 0.001) {
            return {
                newValue: oldValue * Math.exp(-newSmallK * tempCoeff),
                newSmallK: newSmallK
            };
        } else {
            const term1 = Math.pow(currentTime, denominator);
            const term2 = Math.pow(oldTime, denominator);
            
            if (isNaN(term1) || isNaN(term2) || !isFinite(term1) || !isFinite(term2)) {
                return {
                    newValue: oldValue * Math.exp(-newSmallK * tempCoeff),
                    newSmallK: newSmallK
                };
            }
            
            const integral_k = small_k1 * Math.pow(oldTime, adj_S) / denominator * (term1 - term2);
            const mean_k = integral_k / tempCoeff;  
            
            if (isNaN(mean_k) || !isFinite(mean_k)) {
                return {
                    newValue: oldValue * Math.exp(-newSmallK * tempCoeff),
                    newSmallK: newSmallK
                };
            } else {
                return {
                    newValue: oldValue * Math.exp(-mean_k * tempCoeff),
                    newSmallK: newSmallK
                };
            }
        }
    }
}

function calculateDecompositionSubstrate(oldValue, oldTime, currentTime, R, S, tempCoeff, oldSmallK) {
    if (currentTime < 30.0) {
        const firstMonth_K = R * Math.pow(30.0, -S);
        const newSmallK = (1.0 - S) * firstMonth_K;
        return {
            newValue: oldValue * Math.exp(-firstMonth_K * tempCoeff),
            newSmallK: newSmallK
        };
    } else {
        const R_new = R * tempCoeff;
        const S1 = 0.933 * Math.pow(R, 0.179);
        const S2 = 0.933 * Math.pow(R_new, 0.179);
        const change = (S2 - S1) / S1;
        let adj_S = S * (1.0 + change);
        
        if (adj_S >= 1.0) adj_S = 0.999;
        if (adj_S <= 0.0) adj_S = 0.001;
        
        const small_k1 = oldSmallK;
        const newSmallK = small_k1 * Math.pow(oldTime, adj_S) * Math.pow(currentTime, -adj_S);
        
        const denominator = (1.0 - adj_S);
        
        if (Math.abs(denominator) < 0.001) {
            return {
                newValue: oldValue * Math.exp(-newSmallK * tempCoeff),
                newSmallK: newSmallK
            };
        } else {
            const term1 = Math.pow(currentTime, denominator);
            const term2 = Math.pow(oldTime, denominator);
            
            if (isNaN(term1) || isNaN(term2) || !isFinite(term1) || !isFinite(term2)) {
                return {
                    newValue: oldValue * Math.exp(-newSmallK * tempCoeff),
                    newSmallK: newSmallK
                };
            }
            
            const integral_k = small_k1 * Math.pow(oldTime, adj_S) / denominator * (term1 - term2);
            const mean_k = integral_k / tempCoeff;
            
            if (isNaN(mean_k) || !isFinite(mean_k)) {
                return {
                    newValue: oldValue * Math.exp(-newSmallK * tempCoeff),
                    newSmallK: newSmallK
                };
            } else {
                return {
                    newValue: oldValue * Math.exp(-mean_k * tempCoeff),
                    newSmallK: newSmallK
                };
            }
        }
    }
}

function getTemperatureCoefficientForDate(date, preCalculatedCoeffs) {
    if (!weatherData || weatherData.length === 0) {
        throw new Error('Weather data is required. Please upload a weather file before running the simulation.');
    }
    
    const year = date.getFullYear();
    const dayOfYear = dateToDay(date);
    
    const key = `${year}-${dayOfYear}`;
    if (preCalculatedCoeffs[key]) {
        return preCalculatedCoeffs[key];
    }
    
    if (isWeatherDaily) {
        let exactMatch = weatherData.find(w => w.year === year && w.doyOrMonth === dayOfYear);
        if (exactMatch) {
            return calculateTemperatureCoeff(exactMatch.tmax, exactMatch.tmin);
        }
        
        const availableForDOY = weatherData.filter(w => w.doyOrMonth === dayOfYear);
        if (availableForDOY.length > 0) {
            const closest = availableForDOY.reduce((prev, curr) => 
                Math.abs(curr.year - year) < Math.abs(prev.year - year) ? curr : prev
            );
            return calculateTemperatureCoeff(closest.tmax, closest.tmin);
        }
        
        let closestDiff = Infinity;
        let closestRecord = null;
        
        weatherData.forEach(record => {
            const diff = Math.abs(record.doyOrMonth - dayOfYear);
            if (diff < closestDiff && diff <= 15) {
                closestDiff = diff;
                closestRecord = record;
            }
        });
        
        if (closestRecord) {
            return calculateTemperatureCoeff(closestRecord.tmax, closestRecord.tmin);
        }
        
    } else {
        const month = date.getMonth() + 1;
        
        let exactMatch = weatherData.find(w => w.year === year && w.doyOrMonth === month);
        if (exactMatch) {
            return calculateTemperatureCoeff(exactMatch.tmax, exactMatch.tmin);
        }
        
        const availableForMonth = weatherData.filter(w => w.doyOrMonth === month);
        if (availableForMonth.length > 0) {
            const closest = availableForMonth.reduce((prev, curr) => 
                Math.abs(curr.year - year) < Math.abs(prev.year - year) ? curr : prev
            );
            return calculateTemperatureCoeff(closest.tmax, closest.tmin);
        }
    }
    
    throw new Error(`No temperature data available for ${formatDateForDisplay(date)} (Year: ${year}, DOY: ${dayOfYear}).`);
}

function calculateSoilC() {
    const soilC = parseFloat(document.getElementById('soil-c').value) || 0;
    const bulkDensity = parseFloat(document.getElementById('bulk-density').value) || 0;
    const depth = parseFloat(document.getElementById('depth').value) || 0;
    
    const totalSoilC = (soilC * bulkDensity * depth / 10).toFixed(1);
    document.getElementById('calculated-soil-c').textContent = totalSoilC;
}

function setDefaultDates() {
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    
    if (!weatherData) {
        startDateInput.value = '';
        endDateInput.value = '';
    }
}

function initializeSubstrateTable() {
    const tbody = document.getElementById('substrate-tbody');
    
    for (let i = 1; i <= 10; i++) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="text-align: center; background: #e0e0e0;">${i}</td>
            <td><input type="date" id="event-date-${i}"></td>
            <td>
                <select id="substrate-type-${i}">
                    <option value="">Select</option>
                    <option value="1">1 - Cereal crop residues</option>
                    <option value="2">2 - Cereal crop roots</option>
                    <option value="3">3 - Legume crop residues</option>
                    <option value="4">4 - Legume crop roots</option>
                    <option value="5">5 - Green manures</option>
                    <option value="6">6 - Animal manures</option>
                </select>
            </td>
            <td><input type="number" id="c-amount-${i}" step="0.001" min="0" placeholder="0.000"></td>
            <td class="cn-only"><input type="number" id="cn-ratio-${i}" step="0.1" min="1" placeholder="25.0"></td>
        `;
        tbody.appendChild(row);
    }
}

function switchTab(tabIndex) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    
    document.getElementById(`tab-${tabIndex}`).classList.add('active');
    document.querySelectorAll('.tab')[tabIndex].classList.add('active');
    
    const outputControls = document.getElementById('output-controls');
    if (tabIndex === 1 && simulationResults) {
        outputControls.style.display = 'block';
    } else {
        outputControls.style.display = 'none';
    }
}

function updateSimulationType() {
    const isCN = document.getElementById('c-n').checked;
    const cnElements = document.querySelectorAll('.cn-only');
    
    cnElements.forEach(el => {
        if (isCN) {
            el.classList.add('show');
            if (el.tagName === 'TH' || el.tagName === 'TD') {
                el.style.display = 'table-cell';
            } else if (el.classList.contains('checkbox-column')) {
                el.style.display = 'flex';
            } else if (el.classList.contains('form-row')) {
                el.style.display = 'flex';
            } else {
                el.style.display = 'block';
            }
        } else {
            el.classList.remove('show');
            el.style.display = 'none';
        }
    });
}

function updateInputMethod() {
    const isExcel = document.getElementById('set-excel').checked;
    const excelButtons = document.getElementById('excel-buttons');
    const substrateTable = document.getElementById('substrate-table');
    
    if (excelButtons) {
        if (isExcel) {
            excelButtons.style.display = 'block';
            substrateTable.style.opacity = '0.5';
            substrateTable.style.pointerEvents = 'none';
        } else {
            excelButtons.style.display = 'none';
            substrateTable.style.opacity = '1';
            substrateTable.style.pointerEvents = 'auto';
            document.getElementById('excel-file-info').style.display = 'none';
        }
    }
}

function resetDates() {
    setDefaultDates();
}

function selectExcelFile() {
    document.getElementById('excel-file-input').click();
}

function loadExcelFile() {
    const fileInput = document.getElementById('excel-file-input');
    const file = fileInput.files[0];
    
    if (!file) return;
    
    selectedExcelFile = file;
    const fileInfo = document.getElementById('excel-file-info');
    fileInfo.style.display = 'block';
    fileInfo.innerHTML = `
        <strong>Selected file:</strong> ${file.name}<br>
        <strong>Size:</strong> ${(file.size / 1024).toFixed(1)} KB<br>
        <strong>Type:</strong> ${file.type || 'Unknown'}<br>
        <em>Click "Open file" to load substrate events from this file</em>
    `;
    
    if (file.name.toLowerCase().endsWith('.csv')) {
        loadSubstrateEventsFromCSV(file);
    } else {
        showError('Excel file loading functionality requires additional libraries. For now, please use CSV format or manually enter data in the panel.');
    }
}

function loadSubstrateEventsFromCSV(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const csvContent = e.target.result;
            const lines = csvContent.trim().split('\n');
            const dataLines = lines.slice(1);
            
            for (let i = 1; i <= 10; i++) {
                document.getElementById(`event-date-${i}`).value = '';
                document.getElementById(`substrate-type-${i}`).value = '';
                document.getElementById(`c-amount-${i}`).value = '';
                const cnRatioField = document.getElementById(`cn-ratio-${i}`);
                if (cnRatioField) cnRatioField.value = '';
            }
            
            dataLines.forEach((line, index) => {
                if (index >= 10) return;
                
                const cols = line.split(',').map(col => col.trim().replace(/"/g, ''));
                const eventNum = index + 1;
                
                if (cols.length >= 4) {
                    const dateField = document.getElementById(`event-date-${eventNum}`);
                    const typeField = document.getElementById(`substrate-type-${eventNum}`);
                    const amountField = document.getElementById(`c-amount-${eventNum}`);
                    const cnRatioField = document.getElementById(`cn-ratio-${eventNum}`);
                    
                    if (cols[0]) {
                        let dateValue = cols[0];
                        if (dateValue.includes('/')) {
                            const parts = dateValue.split('/');
                            if (parts.length === 3) {
                                dateValue = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
                            }
                        }
                        dateField.value = dateValue;
                    }
                    
                    if (cols[1]) {
                        const substrateCode = cols[1].toString();
                        if (['1', '2', '3', '4', '5', '6'].includes(substrateCode)) {
                            typeField.value = substrateCode;
                        }
                    }
                    
                    if (cols[2] && !isNaN(parseFloat(cols[2]))) {
                        amountField.value = parseFloat(cols[2]);
                    }
                    
                    if (cols[3] && !isNaN(parseFloat(cols[3])) && cnRatioField) {
                        cnRatioField.value = parseFloat(cols[3]);
                    }
                }
            });
            
            const fileInfo = document.getElementById('excel-file-info');
            fileInfo.innerHTML = `
                <strong>File loaded:</strong> ${file.name}<br>
                <strong>Events loaded:</strong> ${Math.min(dataLines.length, 10)}<br>
                <em style="color: green;">Substrate events have been loaded into the table</em>
            `;
            
        } catch (error) {
            showError('Error reading CSV file: ' + error.message);
        }
    };
    reader.readAsText(file);
}

function openExcelFile() {
    if (!selectedExcelFile) {
        showError('No file selected. Please select a file first.');
        return;
    }
    
    const fileInfo = document.getElementById('excel-file-info');
    fileInfo.innerHTML = `
        <strong>File:</strong> ${selectedExcelFile.name}<br>
        <strong>Status:</strong> Ready for processing<br>
        <em>File contents would be opened in Excel (simulated in web browser)</em>
    `;
    
    if (selectedExcelFile.name.toLowerCase().endsWith('.csv')) {
        loadSubstrateEventsFromCSV(selectedExcelFile);
    }
}

function createExcelFile() {
    const isCN = document.getElementById('c-n').checked;
    let csvContent = '';
    
    if (isCN) {
        csvContent = 'Date,Substrate_Type,C_Amount_Mg_ha,CN_Ratio,Notes\n';
        csvContent += '# Substrate Types: 1=Cereal crop residues, 2=Cereal crop roots, 3=Legume crop residues, 4=Legume crop roots, 5=Green manures, 6=Animal manures\n';
        csvContent += '# Date format: YYYY-MM-DD\n';
        csvContent += '# Example data below:\n';
        csvContent += '2000-03-15,1,2.5,25.0,Spring wheat residues\n';
        csvContent += '2000-09-20,3,1.8,15.0,Soybean residues\n';
    } else {
        csvContent = 'Date,Substrate_Type,C_Amount_Mg_ha,Notes\n';
        csvContent += '# Substrate Types: 1=Cereal crop residues, 2=Cereal crop roots, 3=Legume crop residues, 4=Legume crop roots, 5=Green manures, 6=Animal manures\n';
        csvContent += '# Date format: YYYY-MM-DD\n';
        csvContent += '# Example data below:\n';
        csvContent += '2000-03-15,1,2.5,Spring wheat residues\n';
        csvContent += '2000-09-20,3,1.8,Soybean residues\n';
    }
    
    for (let i = 0; i < 8; i++) {
        csvContent += ',,,\n';
    }
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Input events-${excelFileCounter}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    const fileInfo = document.getElementById('excel-file-info');
    fileInfo.style.display = 'block';
    fileInfo.innerHTML = `
        <strong>Created file:</strong> Input events-${excelFileCounter}.csv<br>
        <strong>Status:</strong> Template file downloaded<br>
        <em>Fill in the template and use "Select file" to load it back</em>
    `;
    
    excelFileCounter++;
}

function selectWeatherFile() {
    document.getElementById('weather-file-input').click();
}

function loadWeatherFile() {
    const fileInput = document.getElementById('weather-file-input');
    const file = fileInput.files[0];
    
    if (!file) return;
    
    document.getElementById('weather-filename').textContent = file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        parseWeatherFile(e.target.result);
    };
    reader.readAsText(file);
}

function parseWeatherFile(content) {
    const lines = content.trim().split('\n');
    
    if (lines.length < 5) {
        showError('Invalid weather file format. Weather files must have at least 5 lines with proper header format.');
        return;
    }
    
    const dataLines = lines.slice(4);
    
    weatherData = [];
    
    let maxSecondColumn = 0;
    for (let i = 0; i < Math.min(dataLines.length, 50); i++) {
        const line = dataLines[i].trim();
        if (line) {
            const parts = line.split(/\s+/);
            if (parts.length >= 2) {
                const secondCol = parseInt(parts[1]);
                if (!isNaN(secondCol)) {
                    maxSecondColumn = Math.max(maxSecondColumn, secondCol);
                }
            }
        }
    }
    
    isWeatherDaily = maxSecondColumn > 12;
    
    let firstYear = null, firstDOY = null, lastYear = null, lastDOY = null;
    let validRecords = 0;
    let invalidLines = 0;
    
    for (let i = 0; i < dataLines.length; i++) {
        const line = dataLines[i].trim();
        
        if (!line || line.startsWith('#') || line.startsWith('//')) {
            continue;
        }
        
        const parts = line.split(/\s+/);
        
        if (parts.length >= 4) {
            const year = parseInt(parts[0]);
            const doyOrMonth = parseInt(parts[1]);
            const tmax = parseFloat(parts[2]);
            const tmin = parseFloat(parts[3]);
            
            const yearValid = year && year >= 1900 && year <= 2100;
            const doyMonthValid = doyOrMonth && doyOrMonth >= 1 && 
                                  (isWeatherDaily ? doyOrMonth <= 366 : doyOrMonth <= 12);
            const tmaxValid = !isNaN(tmax) && tmax >= -50 && tmax <= 60;
            const tminValid = !isNaN(tmin) && tmin >= -60 && tmin <= 50;
            const tempLogical = tmax >= tmin;
            
            if (yearValid && doyMonthValid && tmaxValid && tminValid && tempLogical) {
                weatherData.push({ year, doyOrMonth, tmax, tmin });
                validRecords++;
                
                if (!firstYear) {
                    firstYear = year;
                    firstDOY = doyOrMonth;
                }
                lastYear = year;
                lastDOY = doyOrMonth;
                
                if (validRecords <= 5) {
                }
            } else {
                invalidLines++;
                if (invalidLines <= 5) {
                }
            }
        } else {
            invalidLines++;
            if (invalidLines <= 5) {
            }
        }
    }
    
    if (validRecords === 0) {
        showError('No valid weather data found. Please check file format and data validity.');
        return;
    }
    
    const startDate = isWeatherDaily ? 
        dayOfYearToDate(firstYear, firstDOY) : 
        new Date(firstYear, firstDOY - 1, 1);
    const endDate = isWeatherDaily ? 
        dayOfYearToDate(lastYear, lastDOY) : 
        new Date(lastYear, lastDOY - 1, new Date(lastYear, lastDOY, 0).getDate());
        
    document.getElementById('weather-dates').textContent = 
        `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
    document.getElementById('weather-type').textContent = 
        isWeatherDaily ? 'Daily weather data' : 'Monthly weather data';
    
    const formatDateForInput = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    
    document.getElementById('start-date').value = formatDateForInput(startDate);
    document.getElementById('end-date').value = formatDateForInput(endDate);
}

function validateInputs() {
    if (!weatherData || weatherData.length === 0) {
        showError('Weather data is required! Please upload a weather file before running the simulation.');
        return false;
    }
    
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    
    if (!startDate || !endDate) {
        showError('Simulation start and end dates must be specified!');
        return false;
    }
    
    if (createSafeDate(startDate) >= createSafeDate(endDate)) {
        showError('Simulation ending date must be after start date!');
        return false;
    }
    
    const simStartDate = createSafeDate(startDate);
    const simEndDate = createSafeDate(endDate);
    
    const weatherStartYear = Math.min(...weatherData.map(w => w.year));
    const weatherEndYear = Math.max(...weatherData.map(w => w.year));
    
    if (simStartDate.getFullYear() < weatherStartYear || simEndDate.getFullYear() > weatherEndYear) {
        showError(`Weather data (${weatherStartYear}-${weatherEndYear}) does not cover the entire simulation period (${simStartDate.getFullYear()}-${simEndDate.getFullYear()}).`);
        return false;
    }
    
    const soilC = document.getElementById('soil-c').value;
    const bulkDensity = document.getElementById('bulk-density').value;
    const depth = document.getElementById('depth').value;
    
    if (!soilC || !bulkDensity || !depth || 
        parseFloat(soilC) <= 0 || parseFloat(bulkDensity) <= 0 || parseFloat(depth) <= 0) {
        showError('Settings for soil properties not complete yet! All values must be greater than 0.');
        return false;
    }
    
    const isCN = document.getElementById('c-n').checked;
    if (isCN && (!document.getElementById('initial-nmin').value || parseFloat(document.getElementById('initial-nmin').value) < 0)) {
        showError('Initial soil Nmin must be specified for C&N simulation and cannot be negative!');
        return false;
    }
    
    return true;
}

async function performSimulation() {
    const isCN = document.getElementById('c-n').checked;
    const startDate = createSafeDate(document.getElementById('start-date').value);
    const endDate = createSafeDate(document.getElementById('end-date').value);
    
    const totalSimulationDays = Math.ceil((endDate - startDate) / (24 * 60 * 60 * 1000)) + 1;
    
    const substrateEvents = [];
    for (let i = 1; i <= 10; i++) {
        const date = document.getElementById(`event-date-${i}`).value;
        const type = document.getElementById(`substrate-type-${i}`).value;
        const amount = document.getElementById(`c-amount-${i}`).value;
        const cnRatio = document.getElementById(`cn-ratio-${i}`).value;
        
        if (date && type && amount) {
            const eventDate = createSafeDate(date);
            
            if (eventDate < startDate || eventDate > endDate) {
                showError(`Event ${i} date ${date} is outside simulation period`);
                return null;
            }
            
            substrateEvents.push({
                date: eventDate,
                type: parseInt(type),
                amount: parseFloat(amount) * 1000, 
                cnRatio: cnRatio ? parseFloat(cnRatio) : (isCN ? 25 : 0)
            });
        }
    }
    
    substrateEvents.sort((a, b) => a.date - b.date);
    
    const soilC = parseFloat(document.getElementById('soil-c').value);
    const bulkDensity = parseFloat(document.getElementById('bulk-density').value);
    const depth = parseFloat(document.getElementById('depth').value);
    const texture = document.getElementById('soil-texture').value;
    
    const soilCMgHa = (soilC * bulkDensity * depth / 10);
    let initialSOC = soilCMgHa * 1000; 
    
    let YtSOC = initialSOC;
    let timeSOM = 0;
    let oldTimeSOM = 0;
    let oldValueSOC = initialSOC;
    
    let totalNetNrelease = 0;
    let totalSoilNmin = isCN ? parseFloat(document.getElementById('initial-nmin').value) : 0;
    let organicN_SOM = isCN ? initialSOC / modelParams.CNratioSOM : 0;
    let totalOrganicN = organicN_SOM;
    let totalN = totalSoilNmin + totalOrganicN;
    let CNratioSOM = modelParams.CNratioSOM;
    
    const substrates = substrateEvents.map(event => ({
        ...event,
        Yt: 0,
        timeDose: 0,
        oldTimeDose: 0,
        oldValueC: 0,
        CNratioVari: event.cnRatio,
        firstMonth_K: 0,
        small_k: 0,
        R: modelParams.R_substrates[event.type] * modelParams.textureAdjustment[texture].R,
        S: modelParams.S_substrates[event.type] * modelParams.textureAdjustment[texture].S,
        organicN: isCN ? (event.amount / event.cnRatio) : 0,
        applied: false
    }));
    
    const R_SOM_base = modelParams.R_SOM;
    const S_SOM_base = modelParams.S_SOM;
    const firstMonth_K_SOM = R_SOM_base * Math.pow(30.0, -S_SOM_base);
    let som_k = (1.0 - S_SOM_base) * firstMonth_K_SOM;
    
    const results = [];
    let DAS = 0;
    
    const tempCoeffs = {};
    
    if (isWeatherDaily) {
        weatherData.forEach(w => {
            const key = `${w.year}-${w.doyOrMonth}`;
            tempCoeffs[key] = calculateTemperatureCoeff(w.tmax, w.tmin);
        });
    } else {
        weatherData.forEach(w => {
            const key = `${w.year}-${w.doyOrMonth}`;
            tempCoeffs[key] = calculateTemperatureCoeff(w.tmax, w.tmin);
        });
    }
    
    const currentSimDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const endSimDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    
    const progressUpdateFreq = Math.max(50, Math.floor(totalSimulationDays / 100));
    
    while (currentSimDate <= endSimDate) {
        DAS++;
        
        if (DAS % progressUpdateFreq === 0 || DAS === 1) {
            const progress = (DAS / totalSimulationDays) * 100;
            document.getElementById('progress-fill').style.width = progress + '%';
            
            if (DAS % 1000 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
        
        const tempCoeff = getTemperatureCoefficientForDate(currentSimDate, tempCoeffs);
        
        if (DAS <= 5) {
        }
        
        substrates.forEach(substrate => {
            if (!substrate.applied && 
                currentSimDate.getFullYear() === substrate.date.getFullYear() &&
                currentSimDate.getMonth() === substrate.date.getMonth() &&
                currentSimDate.getDate() === substrate.date.getDate()) {
                
                substrate.applied = true;
                substrate.oldValueC = substrate.amount;
                substrate.Yt = substrate.amount;
                substrate.timeDose = 0;
                substrate.oldTimeDose = 0;
                substrate.firstMonth_K = substrate.R * Math.pow(30.0, -substrate.S);
                substrate.small_k = (1.0 - substrate.S) * substrate.firstMonth_K;
                
                if (isCN) {
                    totalOrganicN += substrate.organicN;
                    totalN = totalSoilNmin + totalOrganicN;
                }
                
            }
        });
        
        let C_dissim_SOM = 0;
        let C_assim_SOM = 0;
        
        if (DAS > 1) {
            timeSOM = oldTimeSOM + tempCoeff;
            
            const somResult = calculateDecompositionSOM(oldValueSOC, oldTimeSOM, timeSOM, R_SOM_base, S_SOM_base, tempCoeff, som_k);
            YtSOC = somResult.newValue;
            som_k = somResult.newSmallK;
            
            if (YtSOC < 0) YtSOC = 0;
            if (YtSOC > oldValueSOC) YtSOC = oldValueSOC;
            
            C_dissim_SOM = oldValueSOC - YtSOC;
            C_assim_SOM = C_dissim_SOM / modelParams.DAratioMin;
            
            if (isCN && C_dissim_SOM > 0) {
                const netNreleaseDaily = calculateNDynamics(
                    C_dissim_SOM, 
                    C_assim_SOM, 
                    CNratioSOM, 
                    modelParams.CNratioMicrobeMax 
                );
                totalNetNrelease += netNreleaseDaily;
                organicN_SOM = Math.max(0.0001, organicN_SOM - netNreleaseDaily);
                totalSoilNmin += netNreleaseDaily;
                totalOrganicN = Math.max(0, totalOrganicN - netNreleaseDaily);
                totalN = totalSoilNmin + totalOrganicN;
                CNratioSOM = YtSOC / organicN_SOM;
            }
        }
        
        oldTimeSOM = timeSOM;
        oldValueSOC = YtSOC;
        
        let totalSubYt = 0;
        let totalSubOrganicN = 0;
        let weightedCNratioSub = 0;
        let totalSubstrateC = 0;
        
        substrates.forEach(substrate => {
            if (substrate.applied && substrate.Yt > 0.001) {
                substrate.timeDose = substrate.oldTimeDose + tempCoeff;
                
                const subResult = calculateDecompositionSubstrate(
                    substrate.oldValueC, 
                    substrate.oldTimeDose, 
                    substrate.timeDose, 
                    substrate.R, 
                    substrate.S, 
                    tempCoeff,
                    substrate.small_k
                );
                substrate.Yt = subResult.newValue;
                substrate.small_k = subResult.newSmallK;
                
                if (substrate.Yt < 0) substrate.Yt = 0;
                if (substrate.Yt > substrate.oldValueC) substrate.Yt = substrate.oldValueC;
                
                if (isCN) {
                    const C_dissim_sub = substrate.oldValueC - substrate.Yt;
                    const C_assim_sub = C_dissim_sub / modelParams.DAratioMax;
                    
                    if (C_dissim_sub > 0) {
                        const netNrelease_sub = calculateNDynamics(
                            C_dissim_sub, 
                            C_assim_sub, 
                            substrate.CNratioVari, 
                            modelParams.CNratioMicrobeMin  
                        );
                        
                        totalNetNrelease += netNrelease_sub;
                        substrate.organicN = Math.max(0.0001, substrate.organicN - netNrelease_sub);
                        totalSoilNmin += netNrelease_sub;
                        substrate.CNratioVari = substrate.Yt / substrate.organicN;
                    }
                    
                    totalSubOrganicN += substrate.organicN;
                }
                
                substrate.oldTimeDose = substrate.timeDose;
                substrate.oldValueC = substrate.Yt;
                
                totalSubYt += substrate.Yt;
                if (isCN && substrate.Yt > 0.001) {
                    weightedCNratioSub += substrate.Yt * substrate.CNratioVari;
                    totalSubstrateC += substrate.Yt;
                }
            }
        });
        
        let grandCNratioSub = 0;
        if (isCN && totalSubstrateC > 0.001) {
            grandCNratioSub = weightedCNratioSub / totalSubstrateC;
        }
        
        if (isCN) {
            totalOrganicN = organicN_SOM + totalSubOrganicN;
            totalN = totalSoilNmin + totalOrganicN;
        }
        
        results.push({
            date: new Date(currentSimDate.getFullYear(), currentSimDate.getMonth(), currentSimDate.getDate()),
            DAS: DAS,
            SOM_C: YtSOC / 1000, 
            substrate_C: totalSubYt / 1000, 
            total_C: (YtSOC + totalSubYt) / 1000, 
            net_Nmin: isCN ? totalNetNrelease : null,
            total_Nmin: isCN ? totalSoilNmin : null,
            total_N: isCN ? totalN : null,
            CN_ratio_res: isCN && grandCNratioSub > 0 ? grandCNratioSub : null,
            CN_ratio_SOM: isCN ? CNratioSOM : null
        });
        
        currentSimDate.setDate(currentSimDate.getDate() + 1);
    }
    
    document.getElementById('progress-fill').style.width = '100%';
    
    return results;
}

function runSimulation() {
    if (!validateInputs()) return;
    
    const runBtn = document.getElementById('run-btn');
    const progressBar = document.getElementById('progress-bar');
    
    runBtn.textContent = "Running...";
    runBtn.classList.add('running');
    runBtn.disabled = true;
    progressBar.style.display = 'block';
    
    setTimeout(async () => {
        try {
            simulationResults = await performSimulation();
            displayResults();
            
            document.getElementById('tab-output').style.color = 'black';
            document.getElementById('tab-graph').style.color = 'black';
            
            
            runBtn.textContent = "It's done!";
            runBtn.style.color = '#00aa00';
            
            setTimeout(() => {
                runBtn.textContent = "Run...";
                runBtn.style.color = '#ff0000';
                runBtn.classList.remove('running');
                runBtn.disabled = false;
            }, 1500);
            
            switchTab(1);
            
        } catch (error) {
            showError('Simulation error: ' + error.message);
            runBtn.textContent = "Run...";
            runBtn.classList.remove('running');
            runBtn.disabled = false;
        } finally {
            progressBar.style.display = 'none';
        }
    }, 100);
}

function displayResults() {
    const isDaily = document.getElementById('daily-output').checked;
    const isCN = document.getElementById('c-n').checked;
    
    let output = '';
    
    if (isDaily) {
        if (isCN) {
            output += 'Simulated C and N mineralization dynamics\n';
            output += 'C variables in Mg/ha; N variables in kg/ha; DAS: days after start.\n\n';
            // Fixed width columns with proper spacing
            output += 'Date'.padEnd(10) + 'DAS'.padEnd(6) + 'SOM-C'.padEnd(12) + 'res-C'.padEnd(12) + 'ttl-C'.padEnd(12) + 'net-Nm'.padEnd(8) + 'ttl-Nm'.padEnd(8) + 'ttl-N'.padEnd(8) + 'res-C:N'.padEnd(8) + 'SOM-C:N\n';
        } else {
            output += 'Simulated C mineralization dynamics\n';
            output += 'C variables in Mg/ha, DAS: days after start.\n\n';
            // Fixed width columns with proper spacing
            output += 'Date'.padEnd(10) + 'DAS'.padEnd(6) + 'SOM-C'.padEnd(12) + 'res-C'.padEnd(12) + 'ttl-C\n';
        }
        
        simulationResults.forEach((result, index) => {
            if (index % 1 === 0) {
                const dateStr = formatDateForDisplay(result.date);
                
                let line = dateStr.padEnd(10) + 
                          result.DAS.toString().padEnd(6) + 
                          result.SOM_C.toFixed(6).padEnd(12) + 
                          result.substrate_C.toFixed(6).padEnd(12) + 
                          result.total_C.toFixed(6).padEnd(12);
                
                if (isCN) {
                    line += (result.net_Nmin?.toFixed(1) || '0.0').padEnd(8) + 
                           (result.total_Nmin?.toFixed(1) || '0.0').padEnd(8) + 
                           (Math.round(result.total_N) || '0').toString().padEnd(8) + 
                           (result.CN_ratio_res?.toFixed(1) || '0.0').padEnd(8) + 
                           (result.CN_ratio_SOM?.toFixed(1) || '10.0');
                }
                
                output += line + '\n';
            }
        });
    } else {
        if (isCN) {
            output += 'Simulated C and N mineralization dynamics.\n';
            output += 'C variables in Mg/ha; N variables in kg/ha; MAS: months after start.\n\n';
            // Fixed width columns with proper spacing
            output += 'Date'.padEnd(10) + 'MAS'.padEnd(6) + 'SOM-C'.padEnd(12) + 'res-C'.padEnd(12) + 'ttl-C'.padEnd(12) + 'net-Nm'.padEnd(8) + 'ttl-Nm'.padEnd(8) + 'ttl-N'.padEnd(8) + 'res-C:N'.padEnd(8) + 'SOM-C:N\n';
        } else {
            output += 'Simulated C mineralization dynamics.\n';
            output += 'C variables in Mg/ha, MAS: months after start.\n\n';
            // Fixed width columns with proper spacing
            output += 'Date'.padEnd(10) + 'MAS'.padEnd(6) + 'SOM-C'.padEnd(12) + 'res-C'.padEnd(12) + 'ttl-C\n';
        }
        
        let lastProcessedMonth = -1;
        let lastProcessedYear = -1;
        
        simulationResults.forEach((result, index) => {
            const currentMonth = result.date.getMonth();
            const currentYear = result.date.getFullYear();
            const currentDay = result.date.getDate();
            
            const isNewMonth = (currentYear !== lastProcessedYear) || (currentMonth !== lastProcessedMonth);
            const isFirstDayOfMonth = currentDay === 1;
            
            if (isFirstDayOfMonth && isNewMonth) {
                const dateStr = formatDateForDisplay(result.date);
                
                const startYear = simulationResults[0].date.getFullYear();
                const startMonth = simulationResults[0].date.getMonth();
                const MAS = ((currentYear - startYear) * 12) + (currentMonth - startMonth) + 1;
                
                let line = dateStr.padEnd(10) + 
                          MAS.toString().padEnd(6) + 
                          result.SOM_C.toFixed(6).padEnd(12) + 
                          result.substrate_C.toFixed(6).padEnd(12) + 
                          result.total_C.toFixed(6).padEnd(12);
                
                if (isCN) {
                    line += (result.net_Nmin?.toFixed(1) || '0.0').padEnd(8) + 
                           (result.total_Nmin?.toFixed(1) || '0.0').padEnd(8) + 
                           (Math.round(result.total_N) || '0').toString().padEnd(8) + 
                           (result.CN_ratio_res?.toFixed(1) || '0.0').padEnd(8) + 
                           (result.CN_ratio_SOM?.toFixed(1) || '10.0');
                }
                
                output += line + '\n';
                
                lastProcessedMonth = currentMonth;
                lastProcessedYear = currentYear;
            }
        });
    }
    
    output += '\n';
    output += addSettingsRecord();
    
    document.getElementById('results-memo').value = output;
}

function addSettingsRecord() {
    const isCN = document.getElementById('c-n').checked;
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const soilC = document.getElementById('soil-c').value;
    const bulkDensity = document.getElementById('bulk-density').value;
    const depth = document.getElementById('depth').value;
    const initialNmin = document.getElementById('initial-nmin').value;
    const texture = document.getElementById('soil-texture').value;
    const weatherFile = document.getElementById('weather-filename').textContent || 'No weather file loaded';
    
    const formatDateForSettings = (dateStr) => {
        const date = createSafeDate(dateStr);
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const year = date.getFullYear();
        return `${month}/${day}/${year}`;
    };
    
    let settings = '';
    settings += 'Settings for the simulation:\n';
    
    if (isCN) {
        settings += '  Carbon and nitrogen\n';
    } else {
        settings += '  Carbon only\n';
    }
    
    settings += `  Weather file: ${weatherFile}\n`;
    settings += `  Weather data type: ${isWeatherDaily ? 'Daily' : 'Monthly'}\n`;
    settings += `  Simulation starts on: ${formatDateForSettings(startDate)}\n`;
    settings += `  Simulation ends on: ${formatDateForSettings(endDate)}\n`;
    settings += '  Substrate input events are set directly on the front page\n';
    
    if (isCN) {
        settings += '  Input events (#, date, substrate type (code), C quantity (Mg/ha), C:N ratio\n';
    } else {
        settings += '  Input events: #, date, substrate type (code), C amount (Mg/ha)\n';
    }
    
    let eventCount = 0;
    for (let i = 1; i <= 10; i++) {
        const date = document.getElementById(`event-date-${i}`).value;
        const type = document.getElementById(`substrate-type-${i}`).value;
        const amount = document.getElementById(`c-amount-${i}`).value;
        const cnRatio = document.getElementById(`cn-ratio-${i}`).value;
        
        if (date && type && amount) {
            eventCount++;
            const eventDate = createSafeDate(date);
            const substrateType = getSubstrateTypeName(parseInt(type));
            
            const month = eventDate.getMonth() + 1;
            const day = eventDate.getDate();
            const year = eventDate.getFullYear();
            const eventDateStr = `${month}/${day}/${year}`;
            
            if (isCN && cnRatio) {
                settings += `    ${eventCount}, ${eventDateStr}, ${substrateType}, ${amount}, ${cnRatio}\n`;
            } else {
                settings += `    ${eventCount}, ${eventDateStr}, ${substrateType}, ${amount}\n`;
            }
        }
    }
    
    settings += '  Soil properties:\n';
    settings += `    Soil C content (g/kg): ${soilC}\n`;
    settings += `    Soil bulk density (g/cm^3): ${bulkDensity}\n`;
    settings += `    Soil depth to simulate (cm): ${depth}\n`;
    
    if (isCN) {
        settings += `    Initial Soil Nmin (kg/ha): ${initialNmin}\n`;
    }
    
    settings += `    Soil texture: ${texture}\n`;
    
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const year = now.getFullYear();
    const dateStr = `${month}/${day}/${year}`;
    
    let hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const timeStr = `${hours}:${minutes}:${seconds} ${ampm}`;
    
    settings += `  Run on ${dateStr}, ${timeStr}`;
    
    return settings;
}

function openInExcel() {
    if (!simulationResults) {
        showError('No results to export');
        return;
    }
    
    const isDaily = document.getElementById('daily-output').checked;
    const isCN = document.getElementById('c-n').checked;
    
    let csv = '';
    
    if (isCN) {
        csv = 'Date,DAS,SOM-C,res-C,ttl-C,net-Nm,ttl-Nm,ttl-N,res-C:N,SOM-C:N\n';
    } else {
        csv = 'Date,DAS,SOM-C,res-C,ttl-C\n';
    }
    
    simulationResults.forEach((result, index) => {
        const currentMonth = result.date.getMonth();
        const currentYear = result.date.getFullYear();
        const currentDay = result.date.getDate();
        
        const shouldInclude = isDaily ? true : (currentDay === 1);
        
        if (shouldInclude) {
            const dateStr = result.date.toLocaleDateString('en-US');
            csv += `${dateStr},${result.DAS},${result.SOM_C.toFixed(6)},${result.substrate_C.toFixed(6)},${result.total_C.toFixed(6)}`;
            
            if (isCN) {
                csv += `,${result.net_Nmin?.toFixed(1) || '0.0'},${result.total_Nmin?.toFixed(1) || '0.0'},${result.total_N?.toFixed(0) || '0'},${result.CN_ratio_res?.toFixed(1) || '0.0'},${result.CN_ratio_SOM?.toFixed(1) || '10.0'}`;
            }
            
            csv += '\n';
        }
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `DK_CN_Results_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function updateChart() {
    if (!simulationResults) return;
    
    const canvas = document.getElementById('chart-canvas');
    const ctx = canvas.getContext('2d');
    
    if (chart) {
        chart.destroy();
    }
    
    const isDaily = document.getElementById('chart-daily-output').checked;
    const isCN = document.getElementById('c-n').checked;
    
    let sampledResults;
    if (isDaily) {
        sampledResults = simulationResults.filter((_, index) => index % 10 === 0);
    } else {
        let lastProcessedMonth = -1;
        let lastProcessedYear = -1;
        sampledResults = simulationResults.filter(result => {
            const currentMonth = result.date.getMonth();
            const currentYear = result.date.getFullYear();
            const currentDay = result.date.getDate();
            
            const isNewMonth = (currentYear !== lastProcessedYear) || (currentMonth !== lastProcessedMonth);
            const isFirstDayOfMonth = currentDay === 1;
            
            if (isFirstDayOfMonth && isNewMonth) {
                lastProcessedMonth = currentMonth;
                lastProcessedYear = currentYear;
                return true;
            }
            return false;
        });
    }
    
    const labels = sampledResults.map(result => 
        dateOnX ? result.date.toLocaleDateString() : result.DAS
    );
    
    const datasets = [];
    
    if (document.getElementById('cb-som-c').checked) {
        datasets.push({
            label: 'SOM-C',
            data: sampledResults.map(r => r.SOM_C),
            borderColor: 'rgb(255, 0, 0)',
            backgroundColor: 'rgba(255, 0, 0, 0.1)',
            yAxisID: 'y'
        });
    }
    
    if (document.getElementById('cb-res-c').checked) {
        datasets.push({
            label: 'Substrate residual C',
            data: sampledResults.map(r => r.substrate_C),
            borderColor: 'rgb(0, 128, 0)',
            backgroundColor: 'rgba(0, 128, 0, 0.1)',
            yAxisID: 'y'
        });
    }
    
    if (document.getElementById('cb-total-c').checked) {
        datasets.push({
            label: 'Total organic C',
            data: sampledResults.map(r => r.total_C),
            borderColor: 'rgb(0, 0, 0)',
            backgroundColor: 'rgba(0, 0, 0, 0.1)',
            yAxisID: 'y'
        });
    }
    
    if (isCN) {
        if (document.getElementById('cb-accum-n').checked) {
            datasets.push({
                label: 'Accum. N mineralization',
                data: sampledResults.map(r => r.net_Nmin),
                borderColor: 'rgb(0, 0, 255)',
                backgroundColor: 'rgba(0, 0, 255, 0.1)',
                yAxisID: 'y1'
            });
        }
        
        if (document.getElementById('cb-total-n').checked) {
            datasets.push({
                label: 'Total soil mineral N',
                data: sampledResults.map(r => r.total_Nmin),
                borderColor: 'rgb(255, 255, 0)',
                backgroundColor: 'rgba(255, 255, 0, 0.1)',
                yAxisID: 'y1'
            });
        }
        
        if (document.getElementById('cb-cn-res').checked) {
            datasets.push({
                label: 'C:N ratio of residues',
                data: sampledResults.map(r => r.CN_ratio_res),
                borderColor: 'rgb(255, 0, 255)',
                backgroundColor: 'rgba(255, 0, 255, 0.1)',
                yAxisID: 'y1'
            });
        }
        
        if (document.getElementById('cb-cn-som').checked) {
            datasets.push({
                label: 'C:N ratio of SOM',
                data: sampledResults.map(r => r.CN_ratio_SOM),
                borderColor: 'rgb(128, 0, 128)',
                backgroundColor: 'rgba(128, 0, 128, 0.1)',
                yAxisID: 'y1'
            });
        }
    }
    
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: isCN ? 'Carbon and Nitrogen Dynamics' : 'Carbon Dynamics'
                },
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: dateOnX ? 'Date' : 'Days after start'
                    }
                },
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Organic C (Mg/ha)'
                    }
                },
            }
        }
    });
}

function updateChartTimeStep() {
    if (simulationResults) {
        updateChart();
    }
}

function toggleXAxis() {
    dateOnX = !dateOnX;
    const button = document.getElementById('das-date-toggle');
    
    if (dateOnX) {
        button.textContent = 'Date / DAS on X';
        button.style.color = '#0000ff';
    } else {
        button.textContent = 'DAS / Date on X';
        button.style.color = '#ff0000';
    }
    
    updateChart();
}

document.addEventListener('DOMContentLoaded', function() {
    
    initializeSubstrateTable();
    calculateSoilC();
    updateSimulationType();
    
    setTimeout(() => {
        setDefaultDates();
    }, 100);
    
    document.getElementById('soil-c').value = '10';
    document.getElementById('bulk-density').value = '1.3';
    document.getElementById('depth').value = '20';
    document.getElementById('initial-nmin').value = '50';
    document.getElementById('soil-texture').value = 'Loam';
    
    calculateSoilC();
    
    document.getElementById('daily-output').addEventListener('change', function() {
        if (simulationResults) displayResults();
    });
    document.getElementById('monthly-output').addEventListener('change', function() {
        if (simulationResults) displayResults();
    });
    document.getElementById('chart-daily-output').addEventListener('change', function() {
        if (simulationResults) updateChart();
    });
    document.getElementById('chart-monthly-output').addEventListener('change', function() {
        if (simulationResults) updateChart();
    });
    
});
