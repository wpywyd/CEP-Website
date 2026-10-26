const picker = document.querySelector('#screen-picker');
const projectModal = document.querySelector('#project-modal');
const voteModal = document.querySelector('#vote-modal');

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((screen) => {
    screen.classList.toggle('active', screen.dataset.view === name);
  });
  picker.value = name;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', (event) => {
  const navigation = event.target.closest('[data-screen]');
  if (navigation) showScreen(navigation.dataset.screen);

  if (event.target.closest('[data-open-project]')) projectModal.showModal();
  if (event.target.closest('.modal-close')) event.target.closest('dialog').close();
  if (event.target.closest('.modal-close-button')) voteModal.close();
});

picker.addEventListener('change', () => showScreen(picker.value));

document.querySelectorAll('input[name="mock-vote"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const title = radio.closest('.ballot-card').querySelector('h3').textContent;
    document.querySelector('#selection-text').innerHTML = `Selected: <strong>${title}</strong>`;
    const button = document.querySelector('#review-vote');
    button.disabled = false;
    button.dataset.project = title;
  });
});

document.querySelector('#review-vote').addEventListener('click', () => {
  const title = document.querySelector('#review-vote').dataset.project;
  voteModal.querySelector('h2').textContent = title;
  voteModal.showModal();
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}
