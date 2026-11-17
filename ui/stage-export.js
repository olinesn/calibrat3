/**
 * ui/stage-export.js — Stage 5: calibration.toml / JSON downloads, board.toml,
 * and session save. (Session load lives in calib/initialization.js because it
 * needs the video loader.)
 */

import { state } from './app-state.js';
import { calibrationTomlFromResults, generateBoardToml } from '../import-export/toml.js';
import { generateCalibrationJson } from '../import-export/sba-json.js';
import { serializeSession, downloadText } from '../import-export/session-save.js';
import { log } from './log-panel.js';
import { $, setEnabled, setStageStatus, showError } from './stages.js';
import { on } from './events.js';

export function setupExportStage() {
    $('exportTomlBtn').addEventListener('click', () => {
        const toml = buildToml();
        if (!toml) { showError('Complete intrinsics and extrinsics first.'); return; }
        downloadText('calibration.toml', toml, 'text/plain');
        log('Downloaded calibration.toml', 'success');
        setStageStatus('stage5', 'Exported', 'complete');
    });
    $('exportSbaJsonBtn').addEventListener('click', () => {
        const data = generateCalibrationJson(state);
        if (!data) { showError('Compute intrinsics first.'); return; }
        const text = JSON.stringify(data);
        downloadText('calibration_data.json', text, 'application/json');
        log(`Downloaded calibration_data.json (${(text.length / 1e6).toFixed(1)} MB, ${data.observations.length} frames, ${data.triangulated_points.length} triangulated frames)`, 'success');
    });
    $('exportBoardBtn').addEventListener('click', () => {
        downloadText('board.toml', generateBoardToml(state.board), 'text/plain');
        log('Downloaded board.toml', 'success');
    });
    $('saveSessionBtn').addEventListener('click', () => {
        const text = JSON.stringify(serializeSession(state));
        const name = `${(state.sessionName || 'session').replace(/[^\w.-]+/g, '_')}.calibrat3.json`;
        downloadText(name, text, 'application/json');
        log(`Saved session ${name} (${(text.length / 1e6).toFixed(1)} MB)`, 'success');
    });
    on('extrinsics-changed', updateTomlPreview);
    on('intrinsics-changed', updateTomlPreview);
    on('detections-changed', updateTomlPreview);
    on('session-loaded', updateTomlPreview);
}

export function buildToml() {
    return calibrationTomlFromResults({
        viewNames: state.views.map(v => v.name), intrinsics: state.intrinsics, extrinsics: state.extrinsics,
        referenceView: state.referenceView, board: state.board, sessionName: state.sessionName,
        sampledFrames: state.sampledFrames.length, refinedBySba: !!state.sbaResult, reproj: state.reproj,
    });
}

export function updateTomlPreview() {
    const pre = $('tomlPreview');
    const toml = buildToml();
    const ready = !!toml && state.views.every((v, i) => state.extrinsics[i] && !state.extrinsics[i].error);
    setEnabled('exportTomlBtn', !!toml);
    setEnabled('exportSbaJsonBtn', state.intrinsics.some(Boolean));
    setEnabled('saveSessionBtn', !!state.detections);
    if (toml) { pre.textContent = toml; pre.classList.remove('muted'); if (ready) setStageStatus('stage5', 'Ready', ''); }
    else { pre.textContent = '# Complete intrinsics and extrinsics to generate the TOML'; pre.classList.add('muted'); }
}
