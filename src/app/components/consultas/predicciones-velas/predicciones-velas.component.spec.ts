import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PrediccionesVelasComponent } from './predicciones-velas.component';

describe('PrediccionesVelasComponent', () => {
  let component: PrediccionesVelasComponent;
  let fixture: ComponentFixture<PrediccionesVelasComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PrediccionesVelasComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PrediccionesVelasComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
