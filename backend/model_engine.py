from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_score, recall_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler


ROOT_DIR = Path(__file__).resolve().parent.parent
DATASET_PATH = ROOT_DIR / 'data' / 'imbalanced_train.csv'

NUMERIC_FEATURES = [
    'Semester',
    'Attendance_Percentage',
    'Internal_Marks',
    'Assignment_Marks',
    'Quiz_Average',
    'Backlogs_Count',
    'CGPA',
]
CATEGORICAL_FEATURES = ['Department']
MODEL_FEATURES = ['Department', *NUMERIC_FEATURES]
RISK_BANDS = {0: 'Low', 1: 'Medium', 2: 'High'}
BAND_TO_LEVEL = {'Low': 'Green', 'Medium': 'Orange', 'High': 'Red'}
CLASS_HEALTH_WEIGHTS = np.array([1.0, 0.68, 0.34])
BAND_PRIORITY = {'High': 0, 'Medium': 1, 'Low': 2}

CAUSE_TO_RECOMMENDATIONS = {
    'Low Attendance': [
        'Maintain attendance above 85% for the next 15 working days.',
        'Collect missed notes or lab records before the next class review.',
        'Meet the class mentor for an attendance recovery check this week.',
    ],
    'Previous Backlogs': [
        'Register for the remedial bridge or backlog support session this week.',
        'Block two fixed weekly slots for backlog clearance subjects.',
        'Review exam dates and preparation targets with the faculty advisor.',
    ],
    'Assignment Submission Gap': [
        'Clear pending assignments before the next internal review date.',
        'Confirm submission order with the subject faculty and lab in-charge.',
        'Reserve one daily submission hour until the backlog of work is closed.',
    ],
    'Low Internal Marks': [
        'Attend the next faculty doubt-clearing session for the weak units.',
        'Solve one previous internal paper before the upcoming assessment.',
        'Track topic-wise errors and review them with the subject teacher.',
    ],
    'Low Quiz Performance': [
        'Join the current quiz revision group for the concerned subject.',
        'Complete two short practice tests before the next quiz window.',
        'Review incorrect answers with the faculty member handling the course.',
    ],
    'Low CGPA': [
        'Schedule an advisor review to set a semester recovery plan.',
        'Prioritize core subjects and reduce avoidable academic backlog.',
        'Maintain a weekly performance tracker until the next evaluation cycle.',
    ],
    'Stable Academic Progress': [
        'Continue the present attendance and submission discipline.',
        'Review progress once this month with the faculty advisor.',
        'Keep preparing with the same weekly academic schedule.',
    ],
}


@dataclass
class AnalysisResult:
    student_id: int
    score: int
    risk_level: str
    risk_band: str
    primary_cause: str
    suggested_action: str
    recommended_actions: list[str]
    contributing_factors: list[str]
    risk_probability: float
    success_probability: float
    class_probabilities: dict[str, float]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class CumulativeOrdinalClassifier(BaseEstimator, ClassifierMixin):
    def __init__(
        self,
        class_weight: str | dict[str, float] | None = 'balanced',
        max_iter: int = 2000,
        random_state: int | None = 42,
        solver: str = 'lbfgs',
    ) -> None:
        self.class_weight = class_weight
        self.max_iter = max_iter
        self.random_state = random_state
        self.solver = solver

    def _build_model(self) -> LogisticRegression:
        return LogisticRegression(
            class_weight=self.class_weight,
            max_iter=self.max_iter,
            random_state=self.random_state,
            solver=self.solver,
        )

    def fit(self, features: Any, labels: Any) -> 'CumulativeOrdinalClassifier':
        ordinal_labels = np.asarray(labels, dtype=int)
        classes = np.unique(ordinal_labels)
        if not np.array_equal(classes, np.array([0, 1, 2])):
            raise ValueError(f'Expected ordinal classes [0, 1, 2], received {classes.tolist()}')

        self.classes_ = classes
        self.lower_boundary_model_ = self._build_model()
        self.upper_boundary_model_ = self._build_model()
        self.lower_boundary_model_.fit(features, (ordinal_labels > 0).astype(int))
        self.upper_boundary_model_.fit(features, (ordinal_labels > 1).astype(int))
        return self

    def predict_proba(self, features: Any) -> np.ndarray:
        probability_above_low = self.lower_boundary_model_.predict_proba(features)[:, 1]
        probability_above_medium = self.upper_boundary_model_.predict_proba(features)[:, 1]
        probability_above_medium = np.minimum(probability_above_medium, probability_above_low)

        low_probability = 1.0 - probability_above_low
        medium_probability = probability_above_low - probability_above_medium
        high_probability = probability_above_medium

        probabilities = np.column_stack([low_probability, medium_probability, high_probability])
        probabilities = np.clip(probabilities, 0.0, 1.0)
        row_totals = probabilities.sum(axis=1, keepdims=True)
        row_totals[row_totals == 0.0] = 1.0
        return probabilities / row_totals

    def predict(self, features: Any) -> np.ndarray:
        return np.argmax(self.predict_proba(features), axis=1)


def _coerce_types(data_frame: pd.DataFrame) -> pd.DataFrame:
    normalized = data_frame.copy()
    normalized['Student_ID'] = normalized['Student_ID'].astype(int)
    normalized['Department'] = normalized['Department'].astype(str)
    normalized['Semester'] = normalized['Semester'].astype(int)
    normalized['Attendance_Percentage'] = normalized['Attendance_Percentage'].astype(float)
    normalized['Internal_Marks'] = normalized['Internal_Marks'].astype(float)
    normalized['Assignment_Marks'] = normalized['Assignment_Marks'].astype(float)
    normalized['Quiz_Average'] = normalized['Quiz_Average'].astype(float)
    normalized['Backlogs_Count'] = normalized['Backlogs_Count'].astype(int)
    normalized['CGPA'] = normalized['CGPA'].astype(float)
    normalized['Risk_Label'] = normalized['Risk_Label'].astype(int)
    return normalized


def _metric_penalties(row: dict[str, Any] | pd.Series) -> dict[str, float]:
    attendance = float(row['Attendance_Percentage'])
    backlogs = int(row['Backlogs_Count'])
    internal_marks = float(row['Internal_Marks'])
    assignment_marks = float(row['Assignment_Marks'])
    quiz_average = float(row['Quiz_Average'])
    cgpa = float(row['CGPA'])

    return {
        'Low Attendance': max(0.0, (75.0 - attendance) / 18.0) * 0.9,
        'Previous Backlogs': backlogs * 0.75,
        'Assignment Submission Gap': max(0.0, (58.0 - assignment_marks) / 11.0) * 1.45,
        'Low Internal Marks': max(0.0, (52.0 - internal_marks) / 11.0) * 1.2,
        'Low Quiz Performance': max(0.0, (52.0 - quiz_average) / 11.0) * 1.2,
        'Low CGPA': max(0.0, (6.6 - cgpa) / 0.75) * 0.95,
    }


def _derive_severity_score(row: dict[str, Any] | pd.Series) -> float:
    return round(sum(_metric_penalties(row).values()), 4)


def _derive_ordinal_labels(data_frame: pd.DataFrame) -> pd.Series:
    severity_scores = data_frame['Severity_Score']
    labels = pd.Series(np.zeros(len(data_frame), dtype=int), index=data_frame.index)
    risk_mask = data_frame['Risk_Label'] == 1

    if risk_mask.any():
        high_threshold = float(severity_scores[risk_mask].quantile(0.75))
        labels.loc[risk_mask] = 1
        labels.loc[risk_mask & (severity_scores >= high_threshold)] = 2

    return labels


def _build_pipeline() -> Pipeline:
    numeric_pipeline = Pipeline(
        steps=[
            ('imputer', SimpleImputer(strategy='median')),
            ('scaler', StandardScaler()),
        ]
    )
    categorical_pipeline = Pipeline(
        steps=[
            ('imputer', SimpleImputer(strategy='most_frequent')),
            ('encoder', OneHotEncoder(handle_unknown='ignore')),
        ]
    )

    preprocessor = ColumnTransformer(
        transformers=[
            ('numeric', numeric_pipeline, NUMERIC_FEATURES),
            ('categorical', categorical_pipeline, CATEGORICAL_FEATURES),
        ]
    )

    return Pipeline(
        steps=[
            ('preprocessor', preprocessor),
            ('classifier', CumulativeOrdinalClassifier(class_weight='balanced', max_iter=2000, random_state=42)),
        ]
    )


class ModelEngine:
    def __init__(self, dataset_path: Path | None = None) -> None:
        self.dataset_path = dataset_path or DATASET_PATH
        self.training_data = self._load_training_data()
        self.pipeline = _build_pipeline()
        self.pipeline.fit(self.training_data[MODEL_FEATURES], self.training_data['Ordinal_Risk_Label'])
        self._analysis_cache: list[dict[str, Any]] | None = None
        self._class_summary_cache: dict[str, Any] | None = None
        self._model_metrics_cache: dict[str, Any] | None = None
        self._analysis_lock = Lock()
        self._summary_lock = Lock()
        self._metrics_lock = Lock()

    def _load_training_data(self) -> pd.DataFrame:
        if not self.dataset_path.exists():
            raise FileNotFoundError(f'Training dataset not found at {self.dataset_path}')

        data_frame = pd.read_csv(self.dataset_path)
        expected_columns = {
            'Student_ID',
            'Department',
            'Semester',
            'Attendance_Percentage',
            'Internal_Marks',
            'Assignment_Marks',
            'Quiz_Average',
            'Backlogs_Count',
            'CGPA',
            'Risk_Label',
        }
        missing = expected_columns.difference(data_frame.columns)
        if missing:
            raise ValueError(f'Dataset missing required columns: {sorted(missing)}')

        normalized = _coerce_types(data_frame)
        normalized['Severity_Score'] = normalized.apply(_derive_severity_score, axis=1)
        normalized['Ordinal_Risk_Label'] = _derive_ordinal_labels(normalized)
        return normalized

    def _derive_primary_cause(self, row: dict[str, Any]) -> str:
        penalties = _metric_penalties(row)
        ranked_penalties = sorted(penalties.items(), key=lambda item: item[1], reverse=True)
        if not ranked_penalties or ranked_penalties[0][1] <= 0.0:
            return 'Stable Academic Progress'
        return ranked_penalties[0][0]

    def _derive_contributing_factors(self, row: dict[str, Any], primary_cause: str) -> list[str]:
        penalties = _metric_penalties(row)
        active_factors = [
            cause
            for cause, score in sorted(penalties.items(), key=lambda item: item[1], reverse=True)
            if score > 0.15 and cause != primary_cause
        ]
        return active_factors[:3]

    def _score_from_probabilities(self, class_probabilities: np.ndarray) -> tuple[int, float, float]:
        success_probability = float(np.dot(class_probabilities, CLASS_HEALTH_WEIGHTS))
        score = int(round(success_probability * 100))
        risk_probability = max(0.0, min(1.0, 1.0 - success_probability))
        return score, success_probability, risk_probability

    def _evaluate_model(self) -> dict[str, Any]:
        features = self.training_data[MODEL_FEATURES]
        labels = self.training_data['Ordinal_Risk_Label']
        splitter = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
        predicted = cross_val_predict(self.pipeline, features, labels, cv=splitter, method='predict')
        confusion = confusion_matrix(labels, predicted, labels=[0, 1, 2])

        precision_by_class = precision_score(labels, predicted, labels=[0, 1, 2], average=None, zero_division=0)
        recall_by_class = recall_score(labels, predicted, labels=[0, 1, 2], average=None, zero_division=0)
        support = labels.value_counts().reindex([0, 1, 2], fill_value=0)

        return {
            'validation_method': '5-fold stratified cross-validation on refined ordinal labels',
            'accuracy': round(float(accuracy_score(labels, predicted)), 4),
            'macro_precision': round(float(precision_score(labels, predicted, average='macro', zero_division=0)), 4),
            'macro_recall': round(float(recall_score(labels, predicted, average='macro', zero_division=0)), 4),
            'macro_f1': round(float(f1_score(labels, predicted, average='macro', zero_division=0)), 4),
            'class_precision': {
                RISK_BANDS[index]: round(float(value), 4)
                for index, value in enumerate(precision_by_class)
            },
            'class_recall': {
                RISK_BANDS[index]: round(float(value), 4)
                for index, value in enumerate(recall_by_class)
            },
            'class_support': {
                RISK_BANDS[index]: int(support.loc[index])
                for index in [0, 1, 2]
            },
            'confusion_matrix': {
                'labels': [RISK_BANDS[index] for index in [0, 1, 2]],
                'matrix': confusion.tolist(),
            },
            'model_choice_reasons': [
                'Ordinal logistic regression keeps the academic states ordered as low, medium, and high risk.',
                'It stays interpretable for faculty because changes in attendance, marks, backlogs, and CGPA have stable linear effects.',
                'It trains quickly on small structured university data and supports consistent retraining during demos or term updates.',
            ],
        }

    def get_model_metrics(self) -> dict[str, Any]:
        if self._model_metrics_cache is None:
            with self._metrics_lock:
                if self._model_metrics_cache is None:
                    self._model_metrics_cache = self._evaluate_model()
        return self._model_metrics_cache

    def analyze_student(self, student_payload: dict[str, Any]) -> AnalysisResult:
        payload = {
            'Department': str(student_payload['Department']),
            'Semester': int(student_payload['Semester']),
            'Attendance_Percentage': float(student_payload['Attendance_Percentage']),
            'Internal_Marks': float(student_payload['Internal_Marks']),
            'Assignment_Marks': float(student_payload['Assignment_Marks']),
            'Quiz_Average': float(student_payload['Quiz_Average']),
            'Backlogs_Count': int(student_payload['Backlogs_Count']),
            'CGPA': float(student_payload['CGPA']),
        }
        inference_frame = pd.DataFrame([payload], columns=MODEL_FEATURES)
        class_probabilities = self.pipeline.predict_proba(inference_frame)[0]
        risk_band = RISK_BANDS[int(np.argmax(class_probabilities))]
        score, success_probability, risk_probability = self._score_from_probabilities(class_probabilities)
        primary_cause = self._derive_primary_cause(student_payload)
        recommended_actions = CAUSE_TO_RECOMMENDATIONS[primary_cause]

        return AnalysisResult(
            student_id=int(student_payload['Student_ID']),
            score=score,
            risk_level=BAND_TO_LEVEL[risk_band],
            risk_band=risk_band,
            primary_cause=primary_cause,
            suggested_action='\n'.join(f'{index + 1}. {action}' for index, action in enumerate(recommended_actions)),
            recommended_actions=recommended_actions,
            contributing_factors=self._derive_contributing_factors(student_payload, primary_cause),
            risk_probability=round(risk_probability, 4),
            success_probability=round(success_probability, 4),
            class_probabilities={
                RISK_BANDS[index]: round(float(probability), 4)
                for index, probability in enumerate(class_probabilities)
            },
        )

    def _build_student_analysis_cache(self) -> list[dict[str, Any]]:
        students = self.training_data.to_dict(orient='records')
        analyzed: list[dict[str, Any]] = []
        for student in students:
            base_record = {
                'Student_ID': int(student['Student_ID']),
                'Department': str(student['Department']),
                'Semester': int(student['Semester']),
                'Attendance_Percentage': float(student['Attendance_Percentage']),
                'Internal_Marks': float(student['Internal_Marks']),
                'Assignment_Marks': float(student['Assignment_Marks']),
                'Quiz_Average': float(student['Quiz_Average']),
                'Backlogs_Count': int(student['Backlogs_Count']),
                'CGPA': float(student['CGPA']),
                'Risk_Label': int(student['Risk_Label']),
                'Severity_Score': float(student['Severity_Score']),
                'Ordinal_Risk_Label': int(student['Ordinal_Risk_Label']),
            }
            analysis = self.analyze_student(base_record)
            analyzed.append({**base_record, **analysis.to_dict()})

        analyzed.sort(
            key=lambda item: (
                BAND_PRIORITY[item['risk_band']],
                item['score'],
                item['Student_ID'],
            )
        )
        return analyzed

    def list_student_analysis(self) -> list[dict[str, Any]]:
        if self._analysis_cache is None:
            with self._analysis_lock:
                if self._analysis_cache is None:
                    self._analysis_cache = self._build_student_analysis_cache()
        return self._analysis_cache

    def _build_class_summary(self) -> dict[str, Any]:
        students = self.list_student_analysis()
        risk_distribution = {'Low': 0, 'Medium': 0, 'High': 0}
        cause_distribution: dict[str, int] = {}
        department_rollup: dict[str, dict[str, float]] = {}

        for student in students:
            risk_distribution[student['risk_band']] += 1
            cause_distribution[student['primary_cause']] = cause_distribution.get(student['primary_cause'], 0) + 1

            department_entry = department_rollup.setdefault(
                student['Department'],
                {
                    'department': student['Department'],
                    'student_count': 0,
                    'score_total': 0.0,
                    'high_risk_count': 0,
                },
            )
            department_entry['student_count'] += 1
            department_entry['score_total'] += float(student['score'])
            if student['risk_band'] == 'High':
                department_entry['high_risk_count'] += 1

        department_performance = []
        for department, values in sorted(department_rollup.items()):
            average_score = values['score_total'] / values['student_count']
            department_performance.append(
                {
                    'department': department,
                    'student_count': int(values['student_count']),
                    'high_risk_count': int(values['high_risk_count']),
                    'average_score': round(average_score, 2),
                }
            )

        return {
            'total_students': len(students),
            'risk_distribution': risk_distribution,
            'cause_distribution': dict(sorted(cause_distribution.items(), key=lambda item: (-item[1], item[0]))),
            'department_performance': department_performance,
            'average_score': round(sum(student['score'] for student in students) / len(students), 2),
            'top_risk_students': students[:8],
        }

    def class_summary(self) -> dict[str, Any]:
        if self._class_summary_cache is None:
            with self._summary_lock:
                if self._class_summary_cache is None:
                    self._class_summary_cache = self._build_class_summary()
        return self._class_summary_cache
