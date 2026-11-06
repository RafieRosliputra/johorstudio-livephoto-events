// Funny progress lines shown while a guest photo uploads. 30 sets of 5 lines; one random set per upload; the guest taps OK to move to the next line.
const SETS = [
['Uploading your cute photo, kawai 🥰', 'Removing nasi lemak from your lips…', 'AI says your face looks like an international celebrity 😎', "Fun fact: nasi lemak is called Malaysia's national dish", 'Mamak, teh one siappp ☕'],
['Sending your photo to the cloud, harap-harap sampai', 'Asking mamak to wait, roti canai still flipping', 'AI is checking: your smile is 98% handsome / beautiful', 'Fun fact: many mamak stalls in Malaysia open 24 hours', 'Teh tarik pulled, upload hampir siap!'],
['Uploading your photo, the cat is also watching 🐱', 'Removing cat hair from the lens…', 'AI detected: this face has main character energy', 'Fun fact: Kuala Lumpur means "muddy confluence"', 'Meow! Almost done!'],
['Uploading your photo, wangi tak?', 'Removing durian smell from your phone…', 'AI says you look like a durian: tough outside, sweet inside 😆', 'Fun fact: durian is called the "king of fruits"', 'Buka durian, siap!'],
['Uploading your photo, kilat sambar sikit', 'Drying your photo, tadi kena hujan', 'AI detected: face looks fresh after the rain', 'Fun fact: Malaysia is hot and rainy almost all year', 'Payung ready, upload siap!'],
['Uploading your photo, pose lawa tu', 'Removing the stranger who photobombed…', 'AI says: this photo deserves a frame 🖼️', 'Fun fact: the Petronas Twin Towers were the tallest buildings in the world from 1998 to 2004', 'Tahniah, you are photogenic!'],
['Uploading your photo, gula kurang manis', 'Pulling your upload like teh tarik…', 'AI says your face looks like a barista champion', 'Fun fact: teh tarik means "pulled tea"', 'Tarik… tarik… siap!'],
['Uploading your photo, jemput makan', 'Removing rendang sauce from your baju…', 'AI says you are the VIP at this kenduri 🎉', 'Fun fact: Malaysians love open house during Hari Raya', 'Tambah nasi, upload siap!'],
['Uploading your photo, gaya terbaik', 'Removing the extra peace sign (just one is enough)…', 'AI says: model material detected 📸', 'Fun fact: Rafflesia from Borneo is one of the biggest flowers in the world', 'Catwalk dulu, then done!'],
['Uploading your photo, jangan bagi monyet curi', 'Removing a monkey from your photo…', 'AI says the monkey is more photogenic than the photographer 🐒', 'Fun fact: orang utan means "person of the forest" in Malay', 'Monyet dah balik, upload siap!'],
['Uploading your photo, sejuk sejuk', 'Removing gula Melaka from your phone…', 'AI says your face looks like a cendol: cute and colourful', 'Fun fact: cendol is a favourite dessert in Malaysia', 'Ais cendol one! Siap!'],
['Uploading your memory, sentap sikit', 'Removing the old ex from the background…', 'AI says this memory is already 100% cute 🥹', 'Fun fact: Mount Kinabalu in Sabah is about 4,095 metres tall', 'Memory saved, move on!'],
['Uploading your photo, bakar perlahan-lahan', 'Removing kuah kacang from your cheek…', 'AI says you look like a satay lover 🍢', 'Fun fact: satay is very popular at Malaysian night markets', 'Satay dah masak, upload siap!'],
['Uploading your photo, roar!', 'Removing lion mane from your hair…', 'AI says you look like a brave lion 🦁', 'Fun fact: Sarawak is called the "Land of the Hornbills"', 'Raung dulu, then done!'],
['Uploading your graduation photo, tahniah!', 'Removing the topi from your eyes…', 'AI says you look smarter already 🎓', 'Fun fact: George Town in Penang is a UNESCO World Heritage Site', 'Dah grad, upload pun siap!'],
['Uploading your photo, sabar ye', 'Asking Wi-Fi to try harder…', 'AI says this Wi-Fi needs more nasi lemak 😅', 'Fun fact: Malaysians love saying "lah" at the end of sentences', 'Wi-Fi okay, upload siap!'],
['Uploading your cute baby photo, comel!', 'Removing the pipi cubit marks…', 'AI says this baby is a star ⭐', 'Fun fact: the wau bulan (moon kite) comes from Kelantan', 'Baby happy, upload siap!'],
['Uploading your beach photo, bawa pasir sekali', 'Removing sand from the lens…', 'AI says you look like a holiday ad 🏖️', 'Fun fact: Malaysia has two parts, Peninsular and Borneo, separated by the South China Sea', 'Ombak tenang, upload siap!'],
['Uploading your photo, dalam proses', 'Folding your photo like roti canai…', 'AI says your face looks like crispy roti canai 🫓', "Fun fact: roti canai is one of Malaysia's favourite breakfasts", 'Dal ready, upload siap!'],
['Uploading your photo… eh, ada orang belakang?', 'Removing a mysterious white figure…', 'AI says: just pocong, harmless 👻', 'Fun fact: Taman Negara is believed to be one of the oldest rainforests in the world', 'Hantu dah lari, upload siap!'],
['Uploading your photo, pedas sikit', 'Removing sambal from the screen…', 'AI says your smile is spicy 🌶️', 'Fun fact: Malaysians love sambal with almost everything', 'Air sejuk ready, upload siap!'],
['Uploading your photo, Johor boleh!', 'Removing traffic from the Johor causeway…', 'AI says you look like a Johor Bahru superstar ⭐', 'Fun fact: Johor is famous for laksa Johor and mee rebus', 'Sampai! Upload siap!'],
['Uploading your photo, wangi bunga', 'Removing the bee from your flower pose…', 'AI says: you are blooming 🌸', "Fun fact: bunga raya (hibiscus) is Malaysia's national flower", 'Bunga mekar, upload siap!'],
['Uploading your photo, kopi O kosong', 'Removing coffee stains from your picture…', 'AI says you look like a morning person ☕', 'Fun fact: Malaysians enjoy kopitiam breakfast with kaya toast', 'Kopi dah sejuk, upload siap!'],
['Uploading your photo, murah murah!', "Removing the penjual's shout from the background…", 'AI says you look like the best bargain of the night 🛍️', 'Fun fact: pasar malam is a night market that moves to different places each day', 'Sold out, upload siap!'],
['Uploading your photo, baju raya baru ni', 'Removing duit raya from your pocket (mak nak simpan)…', 'AI says you are the best dressed at the open house 🧕', 'Fun fact: Malaysia celebrates Hari Raya, Chinese New Year and Deepavali', 'Selamat Hari Raya, upload siap!'],
['Uploading your photo, cape ready', 'Removing the kryptonite…', 'AI says you look like a superhero 💥', "Fun fact: Malaysia is one of the world's megadiverse countries", 'Superhero dah sampai, upload siap!'],
['Uploading your photo, snorkel dulu', 'Removing a fish from your photo…', 'AI says you look like a happy mermaid 🧜', 'Fun fact: Sipadan in Sabah is famous among scuba divers', 'Fishy business done, upload siap!'],
['Uploading your photo, handsome habis', 'Removing the creases from your baju Melayu…', 'AI says you look like a groom 🤵', 'Fun fact: songkok is a traditional hat worn by Malay men', 'Siap bergosok, upload siap!'],
['Uploading your photo, thank you for waiting', 'Removing a tiny bug from the server…', 'AI says you are the best guest at this event 🏆', "Fun fact: Malaysia is one of the biggest rubber glove makers in the world", 'Jom, tengok photo kau!'],
];

/** Confetti burst for ~1.5 s (skipped for people who asked for less motion). */
export function confetti(ms = 1500) {
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch {}
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:200';
  const colors = ['#e8453c', '#f6b73c', '#2e9d6a', '#2f8fd6', '#a45ee0', '#ff7ab6'];
  for (let n = 0; n < 60; n++) {
    const p = document.createElement('i');
    const size = 6 + Math.random() * 6;
    p.style.cssText = `position:absolute;left:50%;top:55%;width:${size}px;height:${size * 1.6}px;background:${colors[n % colors.length]};border-radius:2px`;
    box.appendChild(p);
    const ang = (Math.random() * 2 - 1) * Math.PI * 0.9 - Math.PI / 2, dist = 120 + Math.random() * 260;
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
    p.animate([
      { transform: 'translate(-50%,-50%) rotate(0)', opacity: 1 },
      { transform: `translate(${dx}px,${dy}px) rotate(${Math.random() * 720 - 360}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx * 1.15}px,${dy + 220}px) rotate(${Math.random() * 900 - 450}deg)`, opacity: 0 },
    ], { duration: ms, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' });
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), ms + 100);
}

/** Shows one random set in `line`, one line per tap on `btn` (OK). After the 5th tap, onAll() runs and the button hides. */
export function funnySteps(line, btn, onAll) {
  const set = SETS[Math.floor(Math.random() * SETS.length)];
  let i = 0;
  const show = () => { line.textContent = set[i]; btn.textContent = 'OK'; };
  btn.onclick = () => {
    i++;
    if (i < 5) { show(); return; }
    line.textContent = ''; btn.classList.add('hidden'); btn.onclick = null;
    onAll();
  };
  btn.classList.remove('hidden');
  show();
  return { stop() { line.textContent = ''; btn.classList.add('hidden'); btn.onclick = null; } };
}
