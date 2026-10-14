const searchInput = document.querySelector<HTMLInputElement>('#library-search');
const clearButton = document.querySelector<HTMLButtonElement>('#search-clear');
const filterButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-category-filter]')];
const cards = [...document.querySelectorAll<HTMLElement>('[data-card]')];
const emptyState = document.querySelector<HTMLElement>('#empty-state');
const resultCount = document.querySelector<HTMLElement>('#result-count');
let selectedCategory = 'all';

function updateGallery() {
  const query = (searchInput?.value ?? '').trim().normalize('NFC').toLocaleLowerCase('zh-CN');
  let visibleCount = 0;

  for (const card of cards) {
    const category = card.dataset.category ?? '';
    const searchableText = (card.dataset.search ?? '').normalize('NFC');
    const categoryMatches = selectedCategory === 'all' || category === selectedCategory;
    const queryMatches = query.length === 0 || searchableText.includes(query);
    const visible = categoryMatches && queryMatches;
    card.hidden = !visible;
    if (visible) visibleCount += 1;
  }

  if (emptyState) emptyState.hidden = visibleCount !== 0;
  if (clearButton) clearButton.hidden = query.length === 0;
  if (resultCount) resultCount.textContent = `显示 ${visibleCount} / ${cards.length} 个作品`;
}

searchInput?.addEventListener('input', updateGallery);
clearButton?.addEventListener('click', () => {
  if (!searchInput) return;
  searchInput.value = '';
  searchInput.focus();
  updateGallery();
});

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    selectedCategory = button.dataset.categoryFilter ?? 'all';
    for (const filterButton of filterButtons) {
      filterButton.setAttribute('aria-pressed', String(filterButton === button));
    }
    updateGallery();
  });
}
