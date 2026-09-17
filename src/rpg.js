// Заготовка RPG-системы (Фаза 2).
// Реальная логика будет добавлена отдельно: персонажи, инвентарь, бои, экономика, кланы.
// Данные планируем хранить в Supabase (отдельная таблица rpg_state),
// чтобы не трогать bot_state и не терять совместимость со старыми данными.
class RpgGame {
  constructor(config, stateStore) {
    this.config = config;
    this.stateStore = stateStore;
    this.enabled = false;
  }

  async init() {
    // Фаза 2: подключение таблицы rpg_state, загрузка данных, регистрация команд.
    console.log('🎲 RPG-модуль: заготовка (Фаза 2)');
  }
}

module.exports = { RpgGame };
