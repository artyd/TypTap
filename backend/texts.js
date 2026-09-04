// TypTap multiplayer — race passage banks (uk / en / ru).
//
// Для чесної гонки СЕРВЕР обирає один текст на матч і розсилає його всім
// гравцям однаковим. Банк слів/речень дзеркалить фронтовий LANGDATA
// (index.html), щоб мова гонки збігалася з тренуванням.

const BANKS = {
  en: {
    words: ['the','and','for','you','are','with','that','this','have','from','they','word','type','hand','fast','home','keys','over','when','make','time','good','work','play','learn','focus','speed','light','right','write','again','world','sound','value','quick','brown','jumps','lazy','over','dog'],
    sents: [
      'the quick brown fox jumps over the lazy dog',
      'practice makes typing feel effortless',
      'keep your eyes on the screen not the keys',
      'small steady gains add up to real speed',
      'a calm mind types faster than a rushed one',
      'good rhythm beats raw speed every single time',
      'the more you type the less you have to think',
    ],
  },
  uk: {
    words: ['тато','мама','небо','вода','ліс','сонце','кіт','пес','дім','рука','слово','швидко','тепло','світ','поле','ріка','море','день','ранок','птах'],
    sents: [
      'сонце гріє теплий ліс',
      'вода тече до тихого моря',
      'птахи співають над рікою',
      'руки запамінають шлях до кожної літери',
      'спокійний розум друкує швидше за квапливий',
      'рівний ритм важливіший за голу швидкість',
      'чим більше друкуєш тим менше думаєш про клавіші',
    ],
  },
  ru: {
    words: ['мама','папа','небо','вода','лес','солнце','кот','пес','дом','рука','слово','быстро','тепло','мир','поле','река','море','день','утро','птица'],
    sents: [
      'мягкий свет ложится на траву',
      'птицы поют над тихой рекой',
      'руки запоминают путь к каждой букве',
      'спокойный ум печатает быстрее',
      'ровный ритм важнее голой скорости',
      'чем больше печатаешь тем меньше думаешь о клавишах',
      'маленькие шаги складываются в реальную скорость',
    ],
  },
};

// Приблизна кількість символів для кожної довжини гонки.
const TARGET = { short: 90, medium: 160, long: 260 };

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Будує пасаж потрібної довжини: склеює речення, добиваючи словами, поки не
// набереться цільова кількість символів. Повертає рядок у нижньому регістрі
// без кінцевої крапки — так само, як тексти в тренуваннях.
function pickText(lang, len) {
  const bank = BANKS[lang] || BANKS.en;
  const target = TARGET[len] || TARGET.medium;
  const parts = [];
  let n = 0;
  // Перше речення завжди повне — щоб гонка починалась з осмисленого рядка.
  const first = pick(bank.sents);
  parts.push(first); n += first.length + 1;
  while (n < target) {
    // Далі чергуємо короткі речення й окремі слова для різноманіття.
    const chunk = Math.random() < 0.55 ? pick(bank.sents) : pick(bank.words);
    parts.push(chunk); n += chunk.length + 1;
  }
  return parts.join(' ').slice(0, target + 24).trim();
}

module.exports = { pickText, BANKS };
