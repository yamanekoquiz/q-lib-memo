
(function init() {
  // どこに貼っても、元のスクリプトの実行が終わってから動くようにする
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
    return;
  }
  if (window.__srsPatched) return;
  let ok = false;
  try { ok = Array.isArray(studyPool) && !!document.getElementById('studyRatingButtons'); } catch (e) {}
  if (!ok) {
    console.error('SRSパッチ: 元のアプリが見つかりません。元のHTMLの中(</body>の直前)に貼ってください。');
    return;
  }
  window.__srsPatched = true;
 
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const MASTER_DAYS = 7; // 間隔がこの日数以上になったら「習得」にカウント
  const LABELS = { again: 'もう一度', hard: '難しい', good: '覚えた', easy: '簡単' };
  const CLS = {
    again: 'bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border-rose-500/40',
    hard: 'bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border-amber-500/40',
    good: 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-400/40',
    easy: 'bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-200 border-cyan-500/40'
  };
 
  const ensure = p => {
    if (p.ease == null) p.ease = 2.5;
    if (p.interval == null) p.interval = 0;
    if (p.reps == null) p.reps = 0;
    if (p.lapses == null) p.lapses = 0;
    if (p.due == null) p.due = 0;
    return p;
  };
 
  // 元のローダーはSRS用の項目を捨てるので、保存データから復元する
  try {
    const raw = JSON.parse(localStorage.getItem('quiz_study_pool') || '[]');
    const saved = new Map(raw.filter(x => x && x.id != null).map(x => [Number(x.id), x]));
    studyPool.forEach(p => {
      const r = saved.get(p.id);
      if (r) ['ease', 'interval', 'reps', 'lapses', 'due'].forEach(k => {
        if (Number.isFinite(Number(r[k]))) p[k] = Number(r[k]);
      });
      ensure(p);
    });
  } catch (e) { console.warn('SRSデータの復元に失敗:', e); }
 
  // 評価ごとの次回スケジュールを計算 (SM-2風)
  function next(p, r) {
    let { ease, interval, reps, lapses } = ensure(p);
    if (r === 'again') {
      return { ease: Math.max(1.3, ease - 0.2), interval: 0, reps: 0, lapses: lapses + 1, ms: 10 * MIN };
    }
    let iv;
    if (r === 'hard') {
      iv = reps === 0 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2));
      ease = Math.max(1.3, ease - 0.15);
    } else if (r === 'good') {
      iv = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(interval * ease);
    } else {
      iv = reps === 0 ? 4 : Math.max(interval + 2, Math.round(interval * ease * 1.3));
      ease += 0.15;
    }
    return { ease, interval: iv, reps: reps + 1, lapses, ms: iv * DAY };
  }
 
  function fmt(ms) {
    if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}分`;
    if (ms < DAY) return `${Math.round(ms / HOUR)}時間`;
    return `${Math.round(ms / DAY)}日`;
  }
 
  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-xl bg-slate-900 border border-cyan-400/40 text-cyan-100 text-xs font-bold shadow-lg';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }
 
  function grade(p, r) {
    const n = next(p, r);
    p.ease = n.ease; p.interval = n.interval; p.reps = n.reps; p.lapses = n.lapses;
    p.due = Date.now() + n.ms;
    p.isReview = r === 'again';       // 間違えたら次回は4択で復習
    p.streak = r === 'again' ? 0 : (p.streak || 0) + 1;
    if (p.interval >= MASTER_DAYS) {
      masteredQuestionIds.add(p.id);
      saveMasteredQuestionIds();
      if (r !== 'again') toast(`🎉 習得！ 次回は${fmt(n.ms)}後`);
    } else {
      if (r === 'again') { masteredQuestionIds.delete(p.id); saveMasteredQuestionIds(); }
      toast(`次回は${fmt(n.ms)}後`);
    }
    saveStudyPoolToStorage();
    updateMasteryDashboard();
    renderStudyCard();
  }
 
  // 評価ボタンを4段階に差し替え
  const rb = document.getElementById('studyRatingButtons');
  rb.className = 'hidden w-full grid grid-cols-4 gap-2';
  rb.innerHTML = ['again', 'hard', 'good', 'easy'].map(r => `
    <button onclick="rateCard('${r}')" class="px-2 py-3 rounded-2xl text-xs font-bold border cursor-pointer ${CLS[r]}">
      ${LABELS[r]}<span id="srsInt-${r}" class="block text-[10px] font-mono opacity-70 mt-0.5"></span>
    </button>`).join('');
 
  window.rateCard = r => { const p = studyPool[currentPoolIndex]; if (p) grade(p, r); };
  window.handleChoiceAnswer = (selected, correct) => {
    const p = studyPool[currentPoolIndex];
    if (!p) return;
    if (selected !== correct) toast(`不正解… 正解は「${correct}」`);
    grade(p, selected === correct ? 'good' : 'again');
  };
 
  // 出題: 期限が来ているカードを、期限の古い順に出す
  const origRender = window.renderStudyCard;
  const doneTitle = document.querySelector('#studyCompleteBox h2');
  const doneStats = document.getElementById('studyCompleteStats');
  const titleOrig = doneTitle.textContent, statsOrig = doneStats.textContent;
 
  window.renderStudyCard = function () {
    studyPool.forEach(ensure);
    const now = Date.now();
    let idx = -1;
    studyPool.forEach((p, i) => { if (p.due <= now && (idx < 0 || p.due < studyPool[idx].due)) idx = i; });
 
    if (studyPool.length && idx < 0) {
      document.querySelector('#studyView > div').classList.add('hidden');
      document.getElementById('studyCompleteBox').classList.remove('hidden');
      doneTitle.textContent = '今の復習は完了！';
      doneStats.textContent = `次の復習まで ${fmt(Math.min(...studyPool.map(p => p.due)) - now)}`;
      window.updateQueueBadges();
      return;
    }
    doneTitle.textContent = titleOrig;
    doneStats.textContent = statsOrig;
    if (idx >= 0) currentPoolIndex = idx;
    origRender();
 
    const p = studyPool[currentPoolIndex];
    if (!p) return;
    const q = questions.find(item => item.id === p.id);
    document.querySelectorAll('#studyChoiceBox button').forEach(btn => {
      const text = btn.querySelector('span')?.textContent ?? '';
      btn.removeAttribute('onclick');
      btn.onclick = () => handleChoiceAnswer(text, q ? q.answer : '');
    });
    document.getElementById('studyStreakBadge').textContent =
      `間隔: ${p.interval ? p.interval + '日' : '学習中'} / 忘却: ${p.lapses}回`;
    ['again', 'hard', 'good', 'easy'].forEach(r => {
      const el = document.getElementById('srsInt-' + r);
      if (el) el.textContent = fmt(next(p, r).ms);
    });
  };
 
  // ヘッダーに「復習待ち」の件数を表示
  window.updateQueueBadges = function () {
    const el = document.getElementById('poolStatusHeader');
    if (!el) return;
    const now = Date.now();
    const due = studyPool.filter(p => ensure(p).due <= now).length;
    el.textContent = `復習待ち: ${due}問 / キュー: ${studyPool.length}問`;
  };
 
  updateQueueBadges();
})();
