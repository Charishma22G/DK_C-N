let weatherData = null;
let simulationResults = null;
let chart = null;
let dateOnX = false;
let isWeatherDaily = false;

const modelParams = {
    R_SOM: 0.0018,
    S_SOM: 0.428,
    R_substrates: { 1: 0.149, 2: 0.114, 3: 0.149, 4: 0.149, 5: 0.166, 6: 0.04 },
    S_substrates: { 1: 0.66, 2: 0.67, 3: 0.66, 4: 0.66, 5: 0.64, 6: 0.49 },
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
        Sand: { R: 100.0, S: 100.0 },
        Loam: { R: 139.0, S: 108.0 },
        Clay: { R: 178.0, S: 115.0 }
    }
};

function createSafeDate(dateString) {
    const parts = dateString.split('-');
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

function formatDateForDisplay(date) {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const year = date.getFullYear().toString().slice(-2);
    return `${month}/${day}/${year}`;
}

function dateToDay(date) {
    const start = new Date(date.getFullYear(), 0, 1);
    const diff = date.getTime() - start.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24)) + 1;
}

function dayOfYearToDate(year, dayOfYear) {
    const date = new Date(year, 0, 1);
    date.setDate(dayOfYear);
    return date;
}

function showError(message) {
    document.getElementById('error-message').textContent = message;
    document.getElementById('error-dialog').style.display = 'block';
}

function closeErrorDialog() {
    document.getElementById('error-dialog').style.display = 'none';
}

function getTempCoef(tmax, tmin) {
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
    if (cnRatio <= 0 || cnRatioMicrobe <= 0) return 0;
    
    const grossNrelease = (C_dissim + C_assim) / cnRatio;
    const microbeNuptake = C_assim / cnRatioMicrobe;
    return grossNrelease - microbeNuptake;
}

function adjustS(R, S, tempCoef) {
    const R_new = R * tempCoef;  
    const S1 = 0.933 * Math.pow(R, 0.179);
    const S2 = 0.933 * Math.pow(R_new, 0.179);
    
    if (!isFinite(S1) || !isFinite(S2) || S1 <= 0) {
        return S;
    }
    
    const change = (S2 - S1) / S1;
    let adjustedS = S * (1 + change);
    
    if (adjustedS >= 0.999) adjustedS = 0.999;
    if (adjustedS <= 0.001) adjustedS = 0.001;
    
    return adjustedS;
}

function getTemperatureCoefficientForDate(date) {
    if (!weatherData || weatherData.length === 0) {
        throw new Error('Weather data is required');
    }
    
    const year = date.getFullYear();
    const dayOfYear = dateToDay(date);
    
    if (isWeatherDaily) {
        let match = weatherData.find(w => w.year === year && w.doyOrMonth === dayOfYear);
        if (match) return getTempCoef(match.tmax, match.tmin);
        
        const sameDay = weatherData.filter(w => w.doyOrMonth === dayOfYear);
        if (sameDay.length > 0) {
            const closest = sameDay.reduce((prev, curr) => 
                Math.abs(curr.year - year) < Math.abs(prev.year - year) ? curr : prev
            );
            return getTempCoef(closest.tmax, closest.tmin);
        }
        
        for (let offset = 1; offset <= 7; offset++) {
            let testDOY = dayOfYear + offset;
            match = weatherData.find(w => w.year === year && w.doyOrMonth === testDOY);
            if (match) return getTempCoef(match.tmax, match.tmin);
            
            testDOY = dayOfYear - offset;
            match = weatherData.find(w => w.year === year && w.doyOrMonth === testDOY);
            if (match) return getTempCoef(match.tmax, match.tmin);
        }
    } else {
        const month = date.getMonth() + 1;
        
        let match = weatherData.find(w => w.year === year && w.doyOrMonth === month);
        if (match) return getTempCoef(match.tmax, match.tmin);
        
        const sameMonth = weatherData.filter(w => w.doyOrMonth === month);
        if (sameMonth.length > 0) {
            const closest = sameMonth.reduce((prev, curr) => 
                Math.abs(curr.year - year) < Math.abs(prev.year - year) ? curr : prev
            );
            return getTempCoef(closest.tmax, closest.tmin);
        }
    }
    
    if (weatherData.length > 0) {
        console.warn(`Using fallback weather data for ${formatDateForDisplay(date)}`);
        return getTempCoef(weatherData[0].tmax, weatherData[0].tmin);
    }
    
    throw new Error(`No temperature data available for ${formatDateForDisplay(date)}`);
}

async function performSimulation() {
    console.log("=== EXACT PASCAL SIMULATION ===");
    
    const isCN = document.getElementById('c-n').checked;
    const startDateSimul = createSafeDate(document.getElementById('start-date').value);
    const endDateSimul = createSafeDate(document.getElementById('end-date').value);
    
    const substrates = [];
    
    for (let i = 1; i <= 10; i++) {
        const checkbox = document.getElementById(`event-checkbox-${i}`);
        
        if (checkbox && checkbox.checked) {
            const date = document.getElementById(`event-date-${i}`).value;
            const type = document.getElementById(`substrate-type-${i}`).value;
            const amount = document.getElementById(`c-amount-${i}`).value;
            const cnRatio = document.getElementById(`cn-ratio-${i}`).value;
            
            if (date && type && amount) {
                const amountInKg = parseFloat(amount) * 1000; 
                
                substrates.push({
                    date: createSafeDate(date),
                    type: parseInt(type),
                    amount: amountInKg,
                    cnRatio: cnRatio ? parseFloat(cnRatio) : 70.0
                });
            }
        }
    }
    
    substrates.sort((a, b) => a.date - b.date);
    
    const soilC = parseFloat(document.getElementById('soil-c').value);
    const bulkDensity = parseFloat(document.getElementById('bulk-density').value);
    const depth = parseFloat(document.getElementById('depth').value);
    const texture = document.getElementById('soil-texture').value;
    
    let initialSOC = (soilC * bulkDensity * depth / 10.0) * 1000.0; 
    if (initialSOC === 0 && isCN) {
        initialSOC = 0.0001; 
    }
    
    let YtSOC = initialSOC;
    let timeSOM = 0.0;
    let oldTimeSOM = 0.0;
    let oldValueSOC = initialSOC;
    
    let totalNetNrelease = 0.0;
    let totalOrganicN = 0.0;
    let totalSoilNmin = 0.0;
    let totalN = 0.0;
    let organicN_SOM = 0.0;
    let CNratioSOM = modelParams.CNratioSOM;
    
    if (isCN) {
        organicN_SOM = YtSOC / modelParams.CNratioSOM;
        totalOrganicN = organicN_SOM;
        totalSoilNmin = parseFloat(document.getElementById('initial-nmin').value);
        totalN = totalOrganicN + totalSoilNmin;
    }
    
    const maxDoses = substrates.length;
    const substrateStates = [];
    
    const R_adjust = modelParams.textureAdjustment[texture].R / 100.0;
    const S_adjust = modelParams.textureAdjustment[texture].S / 100.0;
    
    for (let i = 0; i < maxDoses; i++) {
        const substrate = substrates[i];
        substrateStates[i] = {
            date: substrate.date,
            type: substrate.type,
            amount: substrate.amount,
            cnRatio: substrate.cnRatio,
            Yt: 0.0,
            timeDose: 0.0,
            oldTimeDose: 0.0,
            oldValueC: 0.0,
            CNratioVari: 0.0,
            firstMonth_K: 0.0,
            small_k: 0.0,
            R: modelParams.R_substrates[substrate.type] * R_adjust,
            S: modelParams.S_substrates[substrate.type] * S_adjust,
            applied: false
        };
    }
    
    const firstMonth_K_SOM = modelParams.R_SOM * Math.pow(30.0, -modelParams.S_SOM);
    let som_k = (1.0 - modelParams.S_SOM) * firstMonth_K_SOM;
    
    for (let P = 0; P < maxDoses; P++) {
        substrateStates[P].firstMonth_K = substrateStates[P].R * Math.pow(30.0, -substrateStates[P].S);
    }
    
    let grandCNratioSub = maxDoses >= 1 ? substrates[0].cnRatio : 0.0;
    
    const results = [];
    let DAS = 0;
    
    const currentDate = new Date(startDateSimul);
    
    while (currentDate <= endDateSimul) {
        DAS++;
        
        const tempCoef = getTemperatureCoefficientForDate(currentDate);
        
        grandCNratioSub = 0.0;
        let C_dissim = 0.0;
        let C_assim = 0.0;
        
        let CNratioMicrobe = modelParams.CNratioMicrobeMax;
        let DAratio = modelParams.DAratioMin;
        
        if (currentDate.getTime() > startDateSimul.getTime()) { 
            timeSOM = oldTimeSOM + tempCoef;
            
            if (timeSOM < 30.0) {
                YtSOC = oldValueSOC * Math.exp(-firstMonth_K_SOM * tempCoef);
                som_k = (1.0 - modelParams.S_SOM) * firstMonth_K_SOM;
            } else {
                const small_k1 = som_k;
                const adj_S = adjustS(modelParams.R_SOM, modelParams.S_SOM, tempCoef);
                
                som_k = small_k1 / Math.pow(oldTimeSOM, -adj_S) * Math.pow(timeSOM, -adj_S);
                
                const denominator = (1.0 - adj_S);
                const integral_k = small_k1 * Math.pow(oldTimeSOM, adj_S) / denominator * 
                                  (Math.pow(timeSOM, denominator) - Math.pow(oldTimeSOM, denominator));
                const mean_k = integral_k / tempCoef;
                
                YtSOC = oldValueSOC * Math.exp(-mean_k * tempCoef);
            }
            
            C_dissim = oldValueSOC - YtSOC;
            C_assim = C_dissim / DAratio;
        }
        
        oldTimeSOM = timeSOM;
        oldValueSOC = YtSOC;
        
        if (isCN) {
            let netNreleaseDaily = calculateNDynamics(C_dissim, C_assim, CNratioSOM, CNratioMicrobe);
            
            totalNetNrelease += netNreleaseDaily;
            organicN_SOM -= netNreleaseDaily;
            totalSoilNmin += netNreleaseDaily;
            totalOrganicN -= netNreleaseDaily;
            totalN = totalSoilNmin + totalOrganicN;
            
            if (organicN_SOM > 0) {
                CNratioSOM = YtSOC / organicN_SOM;
            } else {
                CNratioSOM = modelParams.CNratioSOM;
            }
        }
        
        let totalSubYt = 0.0;
        let P = 0;
        
        while (P < maxDoses && currentDate >= substrateStates[P].date) {
            const substrate = substrateStates[P];
            
            let decomReduction = 0.0;
            
            if (currentDate.getTime() === substrate.date.getTime()) {
                substrate.Yt = substrate.amount;
                substrate.oldValueC = substrate.amount;
                substrate.applied = true;
                C_dissim = 0.0;
                C_assim = 0.0;
                totalSubYt += substrate.amount;
                
                if (isCN) {
                    let netNreleaseDaily = 0.0;
                    substrate.CNratioVari = substrate.cnRatio;
                    const organicN_sub = substrate.Yt / substrate.cnRatio;
                    totalOrganicN += organicN_sub;
                }
                
            } else {
                let stressFree = !isCN;
                let localCNratioMicrobe = CNratioMicrobe;
                let localDAratio = DAratio;
                
                do {
                    const timeStep = tempCoef * (1 - decomReduction);
                    substrate.timeDose = substrate.oldTimeDose + timeStep;
                    
                    if (substrate.timeDose < 30.0) {
                        substrate.Yt = substrate.oldValueC * Math.exp(-substrate.firstMonth_K * timeStep);
                        substrate.small_k = (1.0 - substrate.S) * substrate.firstMonth_K;
                    } else {
                        const small_k1 = substrate.small_k;
                        const adj_S = adjustS(substrate.R, substrate.S, timeStep);
                        
                        substrate.small_k = small_k1 * Math.pow(substrate.oldTimeDose, adj_S) * 
                                           Math.pow(substrate.timeDose, -adj_S);
                        
                        const denominator = (1.0 - adj_S);
                        const integral_k = small_k1 * Math.pow(substrate.oldTimeDose, adj_S) / denominator *
                                          (Math.pow(substrate.timeDose, denominator) - 
                                           Math.pow(substrate.oldTimeDose, denominator));
                        const mean_k = integral_k / timeStep;
                        substrate.Yt = substrate.oldValueC * Math.exp(-mean_k * timeStep);
                    }
                    
                    C_dissim = substrate.oldValueC - substrate.Yt;
                    C_assim = C_dissim / localDAratio;
                    
                    if (isCN) {
                        let netNrelease_sub = calculateNDynamics(C_dissim, C_assim, 
                                                              substrate.CNratioVari, localCNratioMicrobe);
                        
                        if (totalSoilNmin + netNrelease_sub >= 0) {
                            stressFree = true;
                        } else {
                            const change = 0.01;
                            if (localDAratio < modelParams.DAratioMax) {
                                localDAratio += (modelParams.DAratioMax - modelParams.DAratioMin) * change;
                                localCNratioMicrobe -= (modelParams.CNratioMicrobeMax - modelParams.CNratioMicrobeMin) * change;
                                decomReduction += (1 - 1/(1/modelParams.DAratioMin / (1/modelParams.DAratioMax))) * change;
                            } else {
                                decomReduction = 1;
                                stressFree = true;
                            }
                        }
                    }
                } while (!stressFree);
                
                substrate.oldTimeDose = substrate.timeDose;
                totalSubYt -= C_dissim;
                
                if (isCN) {
                    let netNrelease_sub = calculateNDynamics(C_dissim, C_assim, 
                                                          substrate.CNratioVari, localCNratioMicrobe);
                    
                    totalNetNrelease += netNrelease_sub;
                    totalSoilNmin += netNrelease_sub;
                    
                    const organicN_sub = substrate.oldValueC / substrate.CNratioVari - netNrelease_sub;
                    substrate.CNratioVari = substrate.Yt / organicN_sub;
                    
                    totalOrganicN -= netNrelease_sub;
                    totalN = totalOrganicN + totalSoilNmin;
                }
                
                substrate.oldValueC = substrate.Yt;
            }
            
            P++;
        }
        
        totalSubYt = 0.0;
        let totalSubstrateOrganicN = 0.0;
        
        for (let i = 0; i < maxDoses; i++) {
            if (substrateStates[i].applied) {
                totalSubYt += substrateStates[i].Yt;
                if (isCN) {
                    const substrateOrganicN = substrateStates[i].Yt / substrateStates[i].CNratioVari;
                    totalSubstrateOrganicN += substrateOrganicN;
                }
            }
        }
        
        if (isCN && totalSubstrateOrganicN > 0.001) {
            grandCNratioSub = totalSubYt / totalSubstrateOrganicN;
        }
        
        results.push({
            date: new Date(currentDate),
            DAS: DAS,
            SOM_C: YtSOC / 1000.0, 
            substrate_C: totalSubYt / 1000.0,   
            total_C: (YtSOC + totalSubYt) / 1000.0,
            net_Nmin: isCN ? totalNetNrelease : null,
            total_Nmin: isCN ? totalSoilNmin : null,
            total_N: isCN ? Math.round(totalN) : null,
            CN_ratio_res: isCN && grandCNratioSub > 0 ? grandCNratioSub : null,
            CN_ratio_SOM: isCN ? CNratioSOM : null
        });
        
        currentDate.setDate(currentDate.getDate() + 1);
        
        if (currentDate.getTime() > endDateSimul.getTime()) break;
    }
    
    return results;
}

function calculateSoilC() {
    const soilC = parseFloat(document.getElementById('soil-c').value) || 0;
    const bulkDensity = parseFloat(document.getElementById('bulk-density').value) || 0;
    const depth = parseFloat(document.getElementById('depth').value) || 0;
    
    const totalSoilC = (soilC * bulkDensity * depth / 10).toFixed(1);
    document.getElementById('calculated-soil-c').textContent = totalSoilC;
}

function initializeSubstrateTable() {
    const tbody = document.getElementById('substrate-tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    for (let i = 1; i <= 10; i++) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="event-cell">
                <input type="checkbox" id="event-checkbox-${i}" class="event-checkbox" 
                       onchange="toggleSubstrateEvent(${i})">
                <span class="event-number">${i}</span>
            </td>
            <td><input type="date" id="event-date-${i}" disabled></td>
            <td>
                <select id="substrate-type-${i}" disabled>
                    <option value="">Select</option>
                    <option value="1" selected>Cereal residues</option>
                    <option value="2">Cereal roots</option>
                    <option value="3">Legume residues</option>
                    <option value="4">Legume roots</option>
                    <option value="5">Green manures</option>
                    <option value="6">Animal manures</option>
                </select>
            </td>
            <td><input type="number" id="c-amount-${i}" step="0.001" min="0" 
                       placeholder="Enter amount" disabled></td>
            <td class="cn-only">
                <input type="number" id="cn-ratio-${i}" step="0.1" min="1" 
                       placeholder="Enter C:N ratio" disabled>
            </td>
        `;
        tbody.appendChild(row);
        
        ['event-date', 'substrate-type', 'c-amount', 'cn-ratio'].forEach(prefix => {
            const element = document.getElementById(`${prefix}-${i}`);
            if (element) element.style.backgroundColor = '#f0f0f0';
        });
    }
}

function toggleSubstrateEvent(eventNum) {
    const checkbox = document.getElementById(`event-checkbox-${eventNum}`);
    const inputs = ['event-date', 'substrate-type', 'c-amount', 'cn-ratio'].map(prefix => 
        document.getElementById(`${prefix}-${eventNum}`)
    );
    const isCN = document.getElementById('c-n').checked;
    
    if (checkbox.checked) {
        inputs.forEach((input, index) => {
            if (input && (index < 3 || (index === 3 && isCN))) {
                input.disabled = false;
                input.style.backgroundColor = 'white';
            }
        });
        
        const startDate = document.getElementById('start-date').value;
        const dateInput = document.getElementById(`event-date-${eventNum}`);
        
        if (startDate && dateInput && !dateInput.value) {
            const baseDate = createSafeDate(startDate);
            baseDate.setFullYear(baseDate.getFullYear() + (eventNum - 1));
            dateInput.value = baseDate.toISOString().split('T')[0];
        }
        
    } else {
        inputs.forEach(input => {
            if (input) {
                input.disabled = true;
                input.style.backgroundColor = '#f0f0f0';
                input.value = '';
            }
        });
        const typeSelect = document.getElementById(`substrate-type-${eventNum}`);
        if (typeSelect) typeSelect.selectedIndex = 0;
    }
}

function updateSimulationType() {
    const isCN = document.getElementById('c-n').checked;
    const cnElements = document.querySelectorAll('.cn-only');
    
    cnElements.forEach(el => {
        el.style.display = isCN ? 
            (el.tagName === 'TD' || el.tagName === 'TH' ? 'table-cell' : 'block') : 'none';
    });
    
    for (let i = 1; i <= 10; i++) {
        const checkbox = document.getElementById(`event-checkbox-${i}`);
        const cnInput = document.getElementById(`cn-ratio-${i}`);
        
        if (checkbox && checkbox.checked && cnInput) {
            cnInput.disabled = !isCN;
            cnInput.style.backgroundColor = isCN ? 'white' : '#f0f0f0';
        }
    }
}

function switchTab(tabIndex) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    
    const targetTab = document.getElementById(`tab-${tabIndex}`);
    const targetButton = document.querySelectorAll('.tab')[tabIndex];
    
    if (targetTab) targetTab.classList.add('active');
    if (targetButton) targetButton.classList.add('active');
}

function validateInputs() {
    if (!weatherData || weatherData.length === 0) {
        showError('Weather data is required! Please upload a weather file.');
        return false;
    }
    return true;
}

async function runSimulation() {
    if (!validateInputs()) return;
    
    const runBtn = document.getElementById('run-btn');
    runBtn.textContent = "Running...";
    runBtn.disabled = true;
    
    try {
        simulationResults = await performSimulation();
        displayResults();
        
        runBtn.textContent = "It's done!";
        runBtn.style.color = '#00aa00';
        
        setTimeout(() => {
            runBtn.textContent = "Run...";
            runBtn.style.color = '#ff0000';
            runBtn.disabled = false;
        }, 1500);
        
        switchTab(1);
        
    } catch (error) {
        showError('Simulation error: ' + error.message);
        runBtn.textContent = "Run...";
        runBtn.disabled = false;
    }
}

function displayResults() {
    if (!simulationResults) return;
    
    const isCN = document.getElementById('c-n').checked;
    const isDaily = document.getElementById('daily-output')?.checked !== false;
    let output = '';
    
    let resultsToDisplay = simulationResults;
    
    if (!isDaily) {
        const startDate = simulationResults[0].date;
        const targetDay = startDate.getDate() > 28 ? 1 : startDate.getDate(); 
        
        resultsToDisplay = [];
        let MAS = -1;
        
        simulationResults.forEach(result => {
            if (result.date.getDate() === targetDay) {
                MAS++;
                resultsToDisplay.push({
                    ...result,
                    DAS: MAS 
                });
            }
        });
    }
    
    if (isDaily) {
        output += isCN ? 
            'Simulated C and N mineralization dynamics\nC variables in Mg/ha; N variables in kg/ha; DAS: days after start.\n\n' :
            'Simulated C mineralization dynamics\nC variables in Mg/ha, DAS: days after start.\n\n';
    } else {
        output += isCN ? 
            'Simulated C and N mineralization dynamics\nC variables in Mg/ha; N variables in kg/ha; MAS: months after start.\n\n' :
            'Simulated C mineralization dynamics\nC variables in Mg/ha, MAS: months after start.\n\n';
    }
    
    if (isCN) {
        output += 'Date'.padEnd(10) + (isDaily ? 'DAS' : 'MAS').padEnd(6) + 'SOM-C'.padEnd(12) + 
                 'res-C'.padEnd(12) + 'ttl-C'.padEnd(12) + 'net-Nm'.padEnd(8) + 
                 'ttl-Nm'.padEnd(8) + 'ttl-N'.padEnd(8) + 'res-C:N'.padEnd(8) + 'SOM-C:N\n';
    } else {
        output += 'Date'.padEnd(10) + (isDaily ? 'DAS' : 'MAS').padEnd(6) + 'SOM-C'.padEnd(12) + 
                 'res-C'.padEnd(12) + 'ttl-C\n';
    }
    
    resultsToDisplay.forEach(result => {
        const dateStr = formatDateForDisplay(result.date);
        let line = dateStr.padEnd(10) + 
                  result.DAS.toString().padEnd(6) + 
                  result.SOM_C.toFixed(6).padEnd(12) + 
                  result.substrate_C.toFixed(6).padEnd(12) + 
                  result.total_C.toFixed(6).padEnd(12);
        
        if (isCN) {
            let netNminStr = result.net_Nmin?.toFixed(1) || '0.0';
            if (Math.abs(result.net_Nmin) < 0.05 && result.net_Nmin < 0) {
                netNminStr = '-0.0';
            }
            
            line += netNminStr.padEnd(8) + 
                   (result.total_Nmin?.toFixed(1) || '0.0').padEnd(8) + 
                   (result.total_N?.toString() || '0').padEnd(8) + 
                   (result.CN_ratio_res?.toFixed(1) || '0.0').padEnd(8) + 
                   (result.CN_ratio_SOM?.toFixed(1) || '10.0');
        }
        
        output += line + '\n';
    });
    
    output += '\n';
    output += generateSettingsSummary();
    
    const resultsElement = document.getElementById('results-memo');
    if (resultsElement) {
        resultsElement.value = output;
    }
}

function generateSettingsSummary() {
    const isCN = document.getElementById('c-n').checked;
    const startDate = formatDateForDisplay(createSafeDate(document.getElementById('start-date').value));
    const endDate = formatDateForDisplay(createSafeDate(document.getElementById('end-date').value));
    const weatherFilename = document.getElementById('weather-filename')?.textContent || 'Not specified';
    
    let summary = 'Settings for the simulation:\n';
    
    if (!isCN) {
        summary += '  Carbon only\n';
    } else {
        summary += '  Carbon and nitrogen\n';
    }
    
    summary += `  Weather file: ${weatherFilename}\n`;
    summary += `  Simulation starts on: ${startDate}\n`;
    summary += `  Simulation ends on: ${endDate}\n`;
    summary += '  Substrate input events are set directly on the front page\n';
    
    if (!isCN) {
        summary += '  Input events: #, date, substrate type (code), C amount (Mg/ha)\n';
    } else {
        summary += '  Input events (#, date, substrate type (code), C quantity (Mg/ha), C:N ratio\n';
    }
    
    for (let i = 1; i <= 10; i++) {
        const checkbox = document.getElementById(`event-checkbox-${i}`);
        if (checkbox && checkbox.checked) {
            const date = document.getElementById(`event-date-${i}`).value;
            const type = document.getElementById(`substrate-type-${i}`).value;
            const amount = document.getElementById(`c-amount-${i}`).value;
            const cnRatio = document.getElementById(`cn-ratio-${i}`).value;
            
            if (date && type && amount) {
                const eventDate = formatDateForDisplay(createSafeDate(date));
                let substrateStr = '';
                
                switch(parseInt(type)) {
                    case 1: substrateStr = 'Cereal crop residues (1)'; break;
                    case 2: substrateStr = 'Cereal crop roots (2)'; break;
                    case 3: substrateStr = 'Legume residues (3)'; break;
                    case 4: substrateStr = 'Legume roots (4)'; break;
                    case 5: substrateStr = 'Green manures (5)'; break;
                    case 6: substrateStr = 'Animal manures (6)'; break;
                    default: substrateStr = `Unknown substrate type (${type})`;
                }
                
                if (!isCN) {
                    summary += `    ${i}, ${eventDate}, ${substrateStr}, ${amount}\n`;
                } else {
                    summary += `    ${i}, ${eventDate}, ${substrateStr}, ${amount}, ${cnRatio || '70.0'}\n`;
                }
            }
        }
    }
    
    summary += '  Soil properties:\n';
    summary += `    Soil C content (g/kg): ${document.getElementById('soil-c').value || '0'}\n`;
    summary += `    Soil bulk density (g/cm^3): ${document.getElementById('bulk-density').value || '0'}\n`;
    summary += `    Soil depth to simulate (cm): ${document.getElementById('depth').value || '0'}\n`;
    
    if (isCN) {
        summary += `    Initial Soil Nmin (g/kg): ${document.getElementById('initial-nmin').value || '0'}\n`;
    }
    
    const texture = document.getElementById('soil-texture').value;
    let textureStr = '';
    switch(texture) {
        case 'Sand': textureStr = 'Sand'; break;
        case 'Loam': textureStr = 'Loam'; break;
        case 'Clay': textureStr = 'Clay'; break;
        default: textureStr = 'Unknown';
    }
    summary += `    Soil texture: ${textureStr}\n`;
    
    const now = new Date();
    const dateStr = formatDateForDisplay(now);
    const timeStr = now.toLocaleTimeString();
    summary += `  Run on ${dateStr}, ${timeStr}\n`;
    
    return summary;
}

function selectWeatherFile() {
    const fileInput = document.getElementById('weather-file-input');
    if (fileInput) fileInput.click();
}

function loadWeatherFile() {
    const fileInput = document.getElementById('weather-file-input');
    const file = fileInput?.files[0];
    
    if (!file) return;
    
    const weatherFilename = document.getElementById('weather-filename');
    if (weatherFilename) weatherFilename.textContent = file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        parseWeatherFile(e.target.result);
    };
    reader.readAsText(file);
}

function parseWeatherFile(content) {
    const lines = content.trim().split('\n');
    
    if (lines.length < 5) {
        showError('Invalid weather file format. Must have at least 5 lines.');
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
            
            if (year >= 1900 && year <= 2100 && doyOrMonth >= 1 && 
                (isWeatherDaily ? doyOrMonth <= 366 : doyOrMonth <= 12) &&
                tmax >= -50 && tmax <= 60 && tmin >= -60 && tmin <= 50 && tmax >= tmin) {
                
                weatherData.push({ year, doyOrMonth, tmax, tmin });
                validRecords++;
                
                if (!firstYear) {
                    firstYear = year;
                    firstDOY = doyOrMonth;
                }
                lastYear = year;
                lastDOY = doyOrMonth;
            }
        }
    }
    
    if (validRecords === 0) {
        showError('No valid weather data found.');
        return;
    }
    
    const startDate = isWeatherDaily ? 
        dayOfYearToDate(firstYear, firstDOY) : 
        new Date(firstYear, firstDOY - 1, 1);
    const endDate = isWeatherDaily ? 
        dayOfYearToDate(lastYear, lastDOY) : 
        new Date(lastYear, lastDOY - 1, new Date(lastYear, lastDOY, 0).getDate());
    
    const weatherDates = document.getElementById('weather-dates');
    const weatherType = document.getElementById('weather-type');
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    
    if (weatherDates) weatherDates.textContent = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
    if (weatherType) weatherType.textContent = isWeatherDaily ? 'Daily weather data' : 'Monthly weather data';
    if (startDateInput) startDateInput.value = startDate.toISOString().split('T')[0];
    if (endDateInput) endDateInput.value = endDate.toISOString().split('T')[0];
}

function updateChart() {
    if (!simulationResults || !window.Chart) return;
    
    const canvas = document.getElementById('chart-canvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (chart) {
        chart.destroy();
        chart = null;
    }
    
    const isDaily = document.getElementById('chart-daily-output')?.checked !== false;
    const isCN = document.getElementById('c-n').checked;
    
    let sampledResults = simulationResults;
    if (isDaily && simulationResults.length > 1000) {
        sampledResults = simulationResults.filter((_, index) => 
            index % Math.ceil(simulationResults.length / 1000) === 0);
    } else if (!isDaily) {
        let lastMonth = -1, lastYear = -1;
        sampledResults = simulationResults.filter(result => {
            const currentMonth = result.date.getMonth();
            const currentYear = result.date.getFullYear();
            const currentDay = result.date.getDate();
            
            if (currentDay === 1 && (currentYear !== lastYear || currentMonth !== lastMonth)) {
                lastMonth = currentMonth;
                lastYear = currentYear;
                return true;
            }
            return false;
        });
    }
    
    const labels = sampledResults.map(result => 
        dateOnX ? 
        result.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : 
        result.DAS
    );
    
    const datasets = [];
    const colors = {
        somC: '#FF0000', 
        substrateC: '#00AA00', 
        totalC: '#000000',
        accumN: '#0066FF', 
        totalMinN: '#9966FF', 
        totalN: '#FF6600',
        cnRes: '#FF00FF', 
        cnSom: '#800080'
    };
    
    const somcChecked = document.getElementById('cb-som-c')?.checked;
    const rescChecked = document.getElementById('cb-res-c')?.checked;
    const totalcChecked = document.getElementById('cb-total-c')?.checked;
    
    if (somcChecked) {
        datasets.push({
            label: 'SOM-C',
            data: sampledResults.map(r => r.SOM_C),
            borderColor: colors.somC,
            backgroundColor: 'transparent',
            yAxisID: 'y',
            fill: false,
            tension: 0.1,
            borderWidth: 2,
            pointRadius: 0
        });
    }
    
    if (rescChecked) {
        datasets.push({
            label: 'Residue C',
            data: sampledResults.map(r => r.substrate_C),
            borderColor: colors.substrateC,
            backgroundColor: 'transparent',
            yAxisID: 'y',
            fill: false,
            tension: 0.1,
            borderWidth: 2,
            pointRadius: 0
        });
    }
    
    if (totalcChecked) {
        datasets.push({
            label: 'Total C',
            data: sampledResults.map(r => r.total_C),
            borderColor: colors.totalC,
            backgroundColor: 'transparent',
            yAxisID: 'y',
            fill: false,
            tension: 0.1,
            borderWidth: 2,
            pointRadius: 0
        });
    }
    
    let hasNData = false;
    if (isCN) {
        const accumNChecked = document.getElementById('cb-accum-n')?.checked;
        const totalNMinChecked = document.getElementById('cb-total-n')?.checked;
        const soilNChecked = document.getElementById('cb-soil-n')?.checked;
        
        if (accumNChecked) {
            hasNData = true;
            datasets.push({
                label: 'Net N mineralization',
                data: sampledResults.map(r => r.net_Nmin || 0),
                borderColor: colors.accumN,
                backgroundColor: 'transparent',
                yAxisID: 'y1',
                fill: false,
                tension: 0.1,
                borderWidth: 2,
                pointRadius: 0
            });
        }
        
        if (totalNMinChecked) {
            hasNData = true;
            datasets.push({
                label: 'Total mineral N',
                data: sampledResults.map(r => r.total_Nmin || 0),
                borderColor: colors.totalMinN,
                backgroundColor: 'transparent',
                yAxisID: 'y1',
                fill: false,
                tension: 0.1,
                borderWidth: 2,
                pointRadius: 0
            });
        }
        
        if (soilNChecked) {
            hasNData = true;
            datasets.push({
                label: 'Total soil N',
                data: sampledResults.map(r => r.total_N || 0),
                borderColor: colors.totalN,
                backgroundColor: 'transparent',
                yAxisID: 'y1',
                fill: false,
                tension: 0.1,
                borderWidth: 2,
                pointRadius: 0
            });
        }
        
        const cnResChecked = document.getElementById('cb-cn-res')?.checked;
        const cnSomChecked = document.getElementById('cb-cn-som')?.checked;
        
        if (cnResChecked) {
            datasets.push({
                label: 'Residue C:N',
                data: sampledResults.map(r => r.CN_ratio_res || 0),
                borderColor: colors.cnRes,
                backgroundColor: 'transparent',
                yAxisID: hasNData ? 'y2' : 'y1',
                fill: false,
                tension: 0.1,
                borderWidth: 2,
                pointRadius: 0
            });
        }
        
        if (cnSomChecked) {
            datasets.push({
                label: 'SOM C:N',
                data: sampledResults.map(r => r.CN_ratio_SOM || 10),
                borderColor: colors.cnSom,
                backgroundColor: 'transparent',
                yAxisID: hasNData ? 'y2' : 'y1',
                fill: false,
                tension: 0.1,
                borderWidth: 2,
                pointRadius: 0
            });
        }
    }
    
    const scales = {
        x: {
            title: {
                display: true,
                text: dateOnX ? 'Date' : (isDaily ? 'Days after start (DAS)' : 'Months after start (MAS)'),
                font: { size: 14, weight: 'bold' },
                color: '#000'
            },
            grid: { display: true, color: '#CCCCCC' },
            ticks: { color: '#000', font: { size: 12 } }
        },
        y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: {
                display: true,
                text: 'Organic C (Mg/ha)',
                font: { size: 14, weight: 'bold' },
                color: '#000'
            },
            grid: { display: true, color: '#CCCCCC' },
            ticks: { color: '#000', font: { size: 12 } }
        }
    };
    
    if (hasNData) {
        scales.y1 = {
            type: 'linear',
            display: true,
            position: 'right',
            title: {
                display: true,
                text: 'Nitrogen (kg/ha)',
                font: { size: 14, weight: 'bold' },
                color: '#000'
            },
            grid: { display: false },
            ticks: { color: '#000', font: { size: 12 } }
        };
    }
    
    if ((document.getElementById('cb-cn-res')?.checked || document.getElementById('cb-cn-som')?.checked) && hasNData) {
        scales.y2 = {
            type: 'linear',
            display: false,
            position: 'right',
            min: 0,
            grid: { display: false }
        };
    }
    
    const config = {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: isCN ? 'Carbon and Nitrogen Mineralization Dynamics' : 'Carbon Mineralization Dynamics',
                    font: { size: 16, weight: 'bold' },
                    color: '#000'
                },
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { color: '#000', font: { size: 12 } }
                }
            },
            scales: scales,
            elements: {
                line: { tension: 0.1 },
                point: { radius: 0, hoverRadius: 4 }
            },
            interaction: {
                intersect: false,
                mode: 'index'
            }
        }
    };
    
    try {
        chart = new Chart(ctx, config);
    } catch (error) {
        console.error('Error creating chart:', error);
    }
}

function toggleXAxis() {
    dateOnX = !dateOnX;
    const button = document.getElementById('das-date-toggle');
    
    if (button) {
        if (dateOnX) {
            button.textContent = 'Show DAS';
            button.style.color = '#0000ff';
        } else {
            button.textContent = 'Show Date';
            button.style.color = '#ff0000';
        }
    }
    
    if (simulationResults) {
        updateChart();
    }
}

function initializeChartControls() {
    const defaultCheckedIds = ['cb-som-c', 'cb-res-c', 'cb-total-c'];
    defaultCheckedIds.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) checkbox.checked = true;
    });
}

function resetAllSettings() {
    ['soil-c', 'bulk-density', 'depth', 'initial-nmin'].forEach(id => {
        const elem = document.getElementById(id);
        if (elem) elem.value = '';
    });
    
    for (let i = 1; i <= 10; i++) {
        const checkbox = document.getElementById(`event-checkbox-${i}`);
        if (checkbox && checkbox.checked) {
            checkbox.checked = false;
            toggleSubstrateEvent(i);
        }
    }
    
    ['start-date', 'end-date'].forEach(id => {
        const elem = document.getElementById(id);
        if (elem) elem.value = '';
    });
    
    weatherData = null;
    simulationResults = null;
    calculateSoilC();
}

function openInExcel() {
    if (!simulationResults || simulationResults.length === 0) {
        showError('No simulation results to export. Please run a simulation first.');
        return;
    }
    
    const isCN = document.getElementById('c-n').checked;
    let csvContent = '';
    
    if (isCN) {
        csvContent = 'Date,DAS,SOM_C_Mg_ha,Residue_C_Mg_ha,Total_C_Mg_ha,Net_N_min_kg_ha,Total_N_min_kg_ha,Total_N_kg_ha,Residue_CN_ratio,SOM_CN_ratio\n';
    } else {
        csvContent = 'Date,DAS,SOM_C_Mg_ha,Residue_C_Mg_ha,Total_C_Mg_ha\n';
    }
    
    simulationResults.forEach(result => {
        const dateStr = result.date.toISOString().split('T')[0];
        let line = `${dateStr},${result.DAS},${result.SOM_C.toFixed(6)},${result.substrate_C.toFixed(6)},${result.total_C.toFixed(6)}`;
        
        if (isCN) {
            line += `,${result.net_Nmin?.toFixed(1) || '0.0'},${result.total_Nmin?.toFixed(1) || '0.0'},${result.total_N || 0},${result.CN_ratio_res?.toFixed(1) || '0.0'},${result.CN_ratio_SOM?.toFixed(1) || '10.0'}`;
        }
        
        csvContent += line + '\n';
    });
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `DK_Model_Results_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function selectExcelFile() {
    const fileInput = document.getElementById('excel-file-input');
    if (fileInput) fileInput.click();
}

function loadExcelFile() {
    const fileInput = document.getElementById('excel-file-input');
    const file = fileInput?.files[0];
    
    if (!file) return;
    
    if (file.name.toLowerCase().endsWith('.csv')) {
        loadSubstrateEventsFromCSV(file);
    } else {
        showError('Please use CSV format for substrate events.');
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
                const checkbox = document.getElementById(`event-checkbox-${i}`);
                if (checkbox) {
                    checkbox.checked = false;
                    toggleSubstrateEvent(i);
                }
            }
            
            dataLines.forEach((line, index) => {
                if (index >= 10) return;
                
                const cols = line.split(',').map(col => col.trim().replace(/"/g, ''));
                const eventNum = index + 1;
                
                if (cols.length >= 3 && cols[0] && cols[1] && cols[2]) {
                    const checkbox = document.getElementById(`event-checkbox-${eventNum}`);
                    if (checkbox) {
                        checkbox.checked = true;
                        toggleSubstrateEvent(eventNum);
                        
                        let dateValue = cols[0];
                        if (dateValue.includes('/')) {
                            const parts = dateValue.split('/');
                            if (parts.length === 3) {
                                const year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
                                dateValue = `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
                            }
                        }
                        const dateField = document.getElementById(`event-date-${eventNum}`);
                        if (dateField) dateField.value = dateValue;
                        
                        if (['1', '2', '3', '4', '5', '6'].includes(cols[1])) {
                            const typeField = document.getElementById(`substrate-type-${eventNum}`);
                            if (typeField) typeField.value = cols[1];
                        }
                        
                        if (!isNaN(parseFloat(cols[2]))) {
                            const amountField = document.getElementById(`c-amount-${eventNum}`);
                            if (amountField) amountField.value = parseFloat(cols[2]);
                        }
                        
                        if (cols.length >= 4 && cols[3] && !isNaN(parseFloat(cols[3]))) {
                            const cnRatioField = document.getElementById(`cn-ratio-${eventNum}`);
                            if (cnRatioField) cnRatioField.value = parseFloat(cols[3]);
                        }
                    }
                }
            });
            
        } catch (error) {
            showError('Error reading CSV: ' + error.message);
        }
    };
    reader.readAsText(file);
}

function createExcelFile() {
    const isCN = document.getElementById('c-n').checked;
    
    let csvContent = isCN ? 
        'Date,Substrate_Type,C_Amount_Mg_ha,CN_Ratio,Notes\n' +
        '1/1/1982,1,5.0,70.0,Annual cereal residues\n' +
        '1/1/1983,1,5.0,70.0,Annual cereal residues\n' :
        'Date,Substrate_Type,C_Amount_Mg_ha,Notes\n' +
        '1/1/1982,1,5.0,Annual cereal residues\n' +
        '1/1/1983,1,5.0,Annual cereal residues\n';
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Substrate_Input_Events_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', function() {
    initializeSubstrateTable();
    calculateSoilC();
    updateSimulationType();
    
    if (!window.Chart) {
        const chartScript = document.createElement('script');
        chartScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js';
        chartScript.onload = function() {
            initializeChartControls();
        };
        document.head.appendChild(chartScript);
    } else {
        initializeChartControls();
    }
    
    ['soil-c', 'bulk-density', 'depth'].forEach(id => {
        const elem = document.getElementById(id);
        if (elem) elem.addEventListener('input', calculateSoilC);
    });
    
    ['c-only', 'c-n'].forEach(id => {
        const elem = document.getElementById(id);
        if (elem) elem.addEventListener('change', updateSimulationType);
    });
    
    ['daily-output', 'monthly-output'].forEach(id => {
        const elem = document.getElementById(id);
        if (elem) elem.addEventListener('change', () => {
            if (simulationResults) displayResults();
        });
    });
    
    setTimeout(() => {
        ['chart-daily-output', 'chart-monthly-output'].forEach(id => {
            const elem = document.getElementById(id);
            if (elem) {
                elem.addEventListener('change', () => {
                    if (simulationResults) updateChart();
                });
            }
        });
        
        ['cb-som-c', 'cb-res-c', 'cb-total-c', 'cb-accum-n', 'cb-total-n', 'cb-soil-n', 'cb-cn-res', 'cb-cn-som'].forEach(id => {
            const checkbox = document.getElementById(id);
            if (checkbox) {
                checkbox.addEventListener('change', updateChart);
            }
        });
    }, 500);
});

window.runSimulation = runSimulation;
window.selectWeatherFile = selectWeatherFile;
window.loadWeatherFile = loadWeatherFile;
window.selectExcelFile = selectExcelFile;
window.loadExcelFile = loadExcelFile;
window.createExcelFile = createExcelFile;
window.toggleSubstrateEvent = toggleSubstrateEvent;
window.switchTab = switchTab;
window.closeErrorDialog = closeErrorDialog;
window.updateChart = updateChart;
window.toggleXAxis = toggleXAxis;
window.openInExcel = openInExcel;
window.resetAllSettings = resetAllSettings;
window.initializeChartControls = initializeChartControls;
