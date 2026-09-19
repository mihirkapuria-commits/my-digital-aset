import React from 'react';
import { Category } from '../types';
import { Layers } from 'lucide-react';

interface CategoryFilterProps {
  categories: Category[];
  selectedCategoryId: string | null;
  onSelectCategory: (categoryId: string | null) => void;
  articleCounts: Record<string, number>;
}

export const CategoryFilter: React.FC<CategoryFilterProps> = ({
  categories,
  selectedCategoryId,
  onSelectCategory,
  articleCounts,
}) => {
  const totalCount = Object.values(articleCounts).reduce((a, b) => a + b, 0);

  return (
    <nav aria-label="News Categories" className="border-b border-stone-200 bg-white sticky top-[105px] sm:top-[118px] z-30">
      <div className="max-w-5xl mx-auto px-4 py-2">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1 text-sm font-medium">
          {/* All Categories Tab */}
          <button
            id="cat-all-btn"
            onClick={() => onSelectCategory(null)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full whitespace-nowrap text-xs transition border ${
              selectedCategoryId === null
                ? 'bg-stone-900 text-white border-stone-900 shadow-xs'
                : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100 hover:border-stone-300'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>All Briefings</span>
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${
                selectedCategoryId === null ? 'bg-stone-700 text-stone-200' : 'bg-stone-200 text-stone-600'
              }`}
            >
              {totalCount}
            </span>
          </button>

          {/* Individual Categories */}
          {categories
            .filter((c) => c.isActive)
            .map((cat) => {
              const isSelected = selectedCategoryId === cat.id;
              const count = articleCounts[cat.id] || 0;
              return (
                <button
                  key={cat.id}
                  id={`cat-btn-${cat.slug}`}
                  onClick={() => onSelectCategory(cat.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full whitespace-nowrap text-xs transition border ${
                    isSelected
                      ? 'bg-stone-900 text-white border-stone-900 shadow-xs'
                      : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100 hover:border-stone-300'
                  }`}
                >
                  <span>{cat.name}</span>
                  {count > 0 && (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${
                        isSelected ? 'bg-stone-700 text-stone-200' : 'bg-stone-200 text-stone-600'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </div>
    </nav>
  );
};
